<?php

function rivet_job_path($id) { return rivet_storage() . '/job-' . rivet_id($id) . '.json'; }
function rivet_snapshot_path($id) { return rivet_storage() . '/snapshot-' . rivet_id($id); }
function rivet_deployment_path($id) { return rivet_storage() . '/deploy-' . rivet_id($id); }

function rivet_new_job($kind, $source = null, $request_id = null) {
    $active = rivet_load(rivet_storage() . '/active.json');
    if ($active) {
        $previous = rivet_load(rivet_job_path($active['id']));
        if ($request_id && ($previous['request_id'] ?? null) === $request_id) { return $previous; }
        if ($previous && $previous['status'] !== 'complete' && !($kind === 'restore' && $previous['status'] === 'failed')) {
            throw new RuntimeException('Another job is active: ' . $active['id'] . '. Resume it before starting another job.');
        }
    }
    if ($kind === 'restore') {
        $snapshot = rivet_load(rivet_snapshot_path($source) . '/manifest.json');
        if (!$snapshot || ($snapshot['status'] ?? '') !== 'complete') { throw new RuntimeException('Snapshot is not complete.'); }
    }
    if (is_multisite()) { throw new RuntimeException('Multisite is not supported.'); }
    global $wpdb;
    if (!class_exists('mysqli') || !($wpdb->dbh instanceof mysqli)) { throw new RuntimeException('Remote jobs require a MySQL/MariaDB WordPress database. SQLite is supported as a local export source only.'); }
    $id = bin2hex(random_bytes(16));
    $backup = bin2hex(random_bytes(16));
    $directory = rivet_snapshot_path($backup);
    if (!mkdir($directory, 0700)) { throw new RuntimeException('Cannot create snapshot storage.'); }
    $job = array('id' => $id, 'kind' => $kind, 'source' => $source, 'request_id' => $request_id, 'status' => 'running', 'phase' => 'backup-database', 'backup' => $backup, 'created' => gmdate('c'), 'progress' => 0, 'dump' => array(), 'import' => array());
    rivet_save(rivet_job_path($id), $job);
    rivet_save(rivet_storage() . '/active.json', array('id' => $id));
    return $job;
}

function rivet_job_public($job) {
    $public = array_intersect_key($job, array_flip(array('id', 'kind', 'source', 'status', 'phase', 'backup', 'created', 'progress', 'error')));
    $phase = $job['phase'];
    if ($phase === 'backup-database') {
        $tables = $job['dump']['tables'] ?? array();
        $index = $job['dump']['table'] ?? 0;
        $public['details'] = array('completed' => $index, 'total' => count($tables), 'unit' => 'tables', 'table' => $tables[$index] ?? null, 'rows' => $job['dump']['offset'] ?? 0);
    } elseif ($phase === 'import-database') {
        $public['details'] = array('completed' => $job['import']['offset'] ?? 0, 'total' => $job['database']['size'] ?? 0, 'unit' => 'bytes', 'rows' => $job['import']['row'] ?? 0);
    } else {
        $key = array('backup-files' => 'files', 'apply-files' => 'apply', 'restore-prune' => 'remove')[$phase] ?? null;
        if ($key) { $public['details'] = array('completed' => $job['cursor'] ?? 0, 'total' => count($job[$key] ?? array()), 'unit' => 'files'); }
    }
    return $public;
}

function rivet_cleanup_tables($id) {
    global $wpdb;
    $tables = $wpdb->get_col('SHOW TABLES');
    if ($wpdb->last_error) { throw new RuntimeException('Cannot inspect temporary tables.'); }
    foreach ($tables as $table) {
        if (preg_match('/^_rv[ot]_' . substr(rivet_id($id), 0, 24) . '_[0-9]+$/D', $table)) { rivet_query('DROP TABLE ' . rivet_identifier($table)); }
    }
}

function rivet_cancel_job($id) {
    $job = rivet_load(rivet_job_path($id));
    $active = rivet_load(rivet_storage() . '/active.json');
    if (!$job || !$active || $active['id'] !== $id) { throw new RuntimeException('This job is not active.'); }
    if (!empty($job['mutating'])) { throw new RuntimeException('Live changes have started. Resume this job or restore its backup; cancellation is unsafe.'); }
    rivet_cleanup_tables($id);
    $job['status'] = 'cancelled';
    rivet_save(rivet_job_path($id), $job);
    rivet_save(rivet_storage() . '/active.json', null);
    return rivet_job_public($job);
}

function rivet_complete_job(&$job) {
    rivet_cleanup_tables($job['id']);
    $job['status'] = 'complete';
    $job['phase'] = 'complete';
    rivet_save(rivet_job_path($job['id']), $job);
    rivet_save(rivet_storage() . '/active.json', null);
    if (function_exists('opcache_reset')) { opcache_reset(); }
    wp_cache_flush();
}

function rivet_job_step($id) {
    $path = rivet_job_path($id);
    $job = rivet_load($path);
    if (!$job) { throw new RuntimeException('Job not found.'); }
    $active = rivet_load(rivet_storage() . '/active.json');
    if ($job['status'] === 'complete') {
        if ($active && $active['id'] === $id) { rivet_save(rivet_storage() . '/active.json', null); }
        return rivet_job_public($job);
    }
    if (!$active || $active['id'] !== $id) { throw new RuntimeException('This job has been superseded by a recovery job.'); }
    $job['status'] = 'running';
    unset($job['error']);
    $backup = rivet_snapshot_path($job['backup']);
    try {
        if ($job['phase'] === 'backup-database') {
            if (rivet_dump_batch($backup . '/database.ndjson', $job['dump'], array(), true)) {
                $job['files'] = rivet_files();
                $needed = array_sum(array_column($job['files'], 'size'));
                if (disk_free_space(rivet_storage()) < $needed * 1.2 + 10485760) { throw new RuntimeException('Insufficient space for the safety snapshot.'); }
                $job['phase'] = 'backup-files';
                $job['cursor'] = 0;
            }
        } elseif ($job['phase'] === 'backup-files') {
            if ($job['cursor'] < count($job['files'])) {
                $until = microtime(true) + 2;
                for ($batch = 0; $batch < 100 && $job['cursor'] < count($job['files']) && microtime(true) < $until; $batch++) {
                    $entry = $job['files'][$job['cursor']];
                    rivet_copy(rivet_target($entry['path']), $backup . '/' . hash('sha256', $entry['path']), $entry['sha256']);
                    $job['cursor']++;
                }
            } else {
                $database = array('path' => '@database', 'size' => filesize($backup . '/database.ndjson'), 'sha256' => hash_file('sha256', $backup . '/database.ndjson'));
                rivet_save($backup . '/manifest.json', array('id' => $job['backup'], 'status' => 'complete', 'created' => $job['created'], 'files' => $job['files'], 'database' => $database, 'tables' => $job['dump']['tables'], 'consistency' => 'application-maintenance; external database writers must be paused'));
                if ($job['kind'] === 'backup') { rivet_complete_job($job); return rivet_job_public($job); }
                if ($job['kind'] === 'deploy') {
                    $source = rivet_deployment_path($job['source']);
                    $manifest = rivet_load($source . '/manifest.json');
                    $job['apply'] = $manifest['files'];
                    $job['database'] = $manifest['database'];
                    $job['data_path'] = $source . '/' . hash('sha256', '@database');
                    $job['source_path'] = $source;
                    $job['remove'] = array();
                    $job['remove_tables'] = array();
                } else {
                    $source = rivet_snapshot_path($job['source']);
                    $manifest = rivet_load($source . '/manifest.json');
                    $job['apply'] = $manifest['files'];
                    $job['database'] = $manifest['database'];
                    $job['data_path'] = $source . '/database.ndjson';
                    $job['source_path'] = $source;
                    $job['remove'] = array_values(array_diff(array_column($job['files'], 'path'), array_column($job['apply'], 'path')));
                    $job['remove_tables'] = array_values(array_diff($job['dump']['tables'], $manifest['tables']));
                }
                if ($job['database'] && !hash_equals($job['database']['sha256'], hash_file('sha256', $job['data_path']))) { throw new RuntimeException('Database checksum mismatch.'); }
                $job['phase'] = $job['database'] ? 'import-database' : 'apply-files';
                $job['cursor'] = 0;
            }
        } elseif ($job['phase'] === 'import-database') {
            if (!empty($job['import_inflight'])) { $job['import'] = array(); }
            $job['import_inflight'] = true;
            rivet_save($path, $job);
            $finished = rivet_import_batch($job['data_path'], $job['import'], $job['id'], get_option('home'));
            $job['import_inflight'] = false;
            if ($finished) {
                if ($job['kind'] === 'deploy' && (array_diff($job['database']['tables'], array_keys($job['import']['tables'])) || array_diff(array_keys($job['import']['tables']), $job['database']['tables']))) { throw new RuntimeException('Database tables do not match deployment manifest.'); }
                $job['phase'] = 'apply-files';
                $job['cursor'] = 0;
            }
        } elseif ($job['phase'] === 'apply-files') {
            $job['mutating'] = true;
            rivet_save($path, $job);
            if ($job['cursor'] < count($job['apply'])) {
                $until = microtime(true) + 2;
                for ($batch = 0; $batch < 100 && $job['cursor'] < count($job['apply']) && microtime(true) < $until; $batch++) {
                    $entry = $job['apply'][$job['cursor']];
                    rivet_copy($job['source_path'] . '/' . hash('sha256', $entry['path']), rivet_target($entry['path']), $entry['sha256'], 0644);
                    $job['cursor']++;
                }
            } else { $job['phase'] = $job['database'] ? 'switch-database' : 'restore-prune'; $job['cursor'] = 0; }
        } elseif ($job['phase'] === 'switch-database') {
            rivet_swap_tables($job['import'], $job['id'], $job['remove_tables']);
            $job['phase'] = 'restore-prune';
            $job['cursor'] = 0;
        } elseif ($job['phase'] === 'restore-prune') {
            if ($job['cursor'] < count($job['remove'])) {
                $until = microtime(true) + 2;
                for ($batch = 0; $batch < 100 && $job['cursor'] < count($job['remove']) && microtime(true) < $until; $batch++) {
                    $target = rivet_target($job['remove'][$job['cursor']]);
                    if (is_file($target) && !unlink($target)) { throw new RuntimeException('Cannot remove a file absent from the snapshot.'); }
                    $job['cursor']++;
                }
            } else { rivet_complete_job($job); return rivet_job_public($job); }
        } else { throw new RuntimeException('Unknown job phase.'); }
        $job['progress']++;
    } catch (Throwable $error) {
        $job['status'] = 'failed';
        $job['error'] = $error->getMessage();
    }
    rivet_save($path, $job);
    return rivet_job_public($job);
}
