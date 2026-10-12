<?php

function rivet_identifier($value) {
    if (!is_string($value) || !preg_match('/^[A-Za-z0-9_]{1,64}$/D', $value)) {
        throw new RuntimeException('Invalid database identifier.');
    }
    return '`' . $value . '`';
}

function rivet_query($sql) {
    global $wpdb;
    $result = $wpdb->query($sql);
    if ($result === false) {
        throw new RuntimeException('Database operation failed. Check the database server logs and privileges.');
    }
    return $result;
}

function rivet_tables($selection = array()) {
    global $wpdb;
    rivet_identifier($wpdb->prefix);
    if (strpos($wpdb->prefix, '_rv') === 0) { throw new RuntimeException('The database prefix conflicts with Rivet internal tables.'); }
    $tables = $wpdb->get_col('SHOW TABLES');
    if ($wpdb->last_error) {
        throw new RuntimeException('Cannot list database tables.');
    }
    $suffixes = array();
    foreach ($tables as $table) {
        if (strpos($table, $wpdb->prefix) === 0) {
            $suffix = substr($table, strlen($wpdb->prefix));
            rivet_identifier($suffix);
            $suffixes[] = $suffix;
        }
    }
    sort($suffixes);
    if ($selection) {
        if (array_diff($selection, $suffixes)) {
            throw new RuntimeException('A selected table does not exist. Use table suffixes, such as posts, not wp_posts.');
        }
        $suffixes = array_values(array_unique($selection));
    }
    if (class_exists('mysqli') && $wpdb->dbh instanceof mysqli) {
        $triggers = $wpdb->get_results('SHOW TRIGGERS', ARRAY_A);
        if ($wpdb->last_error) { throw new RuntimeException('Cannot inspect database triggers.'); }
        foreach ($triggers as $trigger) {
            if (in_array(substr($trigger['Table'], strlen($wpdb->prefix)), $suffixes, true) && strpos($trigger['Table'], $wpdb->prefix) === 0) { throw new RuntimeException('Tables with triggers are not supported.'); }
        }
        $names = array_map(function ($suffix) use ($wpdb) { return "'" . $wpdb->prefix . $suffix . "'"; }, $suffixes);
        if ($names) {
            $references = $wpdb->get_var('SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN (' . implode(',', $names) . ')');
            if ($wpdb->last_error || (int) $references > 0) { throw new RuntimeException('Tables referenced by foreign keys are not supported.'); }
        }
    }
    return $suffixes;
}

function rivet_validate_groups($tables) {
    if (!$tables || count($tables) !== count(array_unique($tables))) {
        throw new RuntimeException('Choose a nonempty, unique table list.');
    }
    foreach ($tables as $table) {
        rivet_identifier($table);
    }
    foreach (array(
        array('posts', 'postmeta', 'terms', 'termmeta', 'term_taxonomy', 'term_relationships', 'comments', 'commentmeta', 'users', 'usermeta'),
        array('users', 'usermeta'),
        array('options', 'users', 'usermeta'),
    ) as $group) {
        if (in_array($group[0], $tables, true) && array_diff($group, $tables)) {
            throw new RuntimeException('Dependent tables must travel together: ' . implode(',', $group));
        }
    }
    foreach (array('postmeta' => 'posts', 'termmeta' => 'posts', 'terms' => 'posts', 'term_taxonomy' => 'posts', 'term_relationships' => 'posts', 'commentmeta' => 'posts', 'comments' => 'posts', 'usermeta' => 'users') as $child => $parent) {
        if (in_array($child, $tables, true) && !in_array($parent, $tables, true)) {
            throw new RuntimeException($child . ' requires ' . $parent . '.');
        }
    }
}

function rivet_schema($sql, $source, $target) {
    rivet_identifier($source);
    rivet_identifier($target);
    $sql = trim($sql);
    $sql = preg_replace('/^DROP TABLE IF EXISTS `?' . preg_quote($source, '/') . '`?;\s*/i', '', $sql);
    $sql = rtrim($sql, "; \r\n\t");
    if (!preg_match('/^CREATE TABLE `?' . preg_quote($source, '/') . '`?\s*\(/i', $sql)) {
        throw new RuntimeException('Unsupported schema. Only base tables can be transferred.');
    }
    $outside = '';
    $quote = null;
    for ($i = 0; $i < strlen($sql); $i++) {
        $c = $sql[$i];
        if ($quote !== null) {
            if ($c === '\\') { $i++; }
            elseif ($c === $quote) {
                if (isset($sql[$i + 1]) && $sql[$i + 1] === $quote) { $i++; }
                else { $quote = null; }
            }
        } elseif (in_array($c, array("'", '"', '`'), true)) { $quote = $c; }
        else { $outside .= $c; }
    }
    if ($quote !== null || preg_match('/;|#|--|\/\*|\b(FOREIGN|REFERENCES|SELECT|DATA\s+DIRECTORY|INDEX\s+DIRECTORY|GENERATED|TABLESPACE)\b/i', $outside)) {
        throw new RuntimeException('Unsupported table schema: foreign keys, generated columns, external tablespaces, and compound statements are not supported.');
    }
    return preg_replace('/^CREATE TABLE `?' . preg_quote($source, '/') . '`?/i', 'CREATE TABLE ' . rivet_identifier($target), $sql, 1);
}

function rivet_header($tables) {
    global $wpdb;
    if (is_multisite()) { throw new RuntimeException('Multisite is not supported in this version.'); }
    return array('type' => 'header', 'version' => 1, 'prefix' => $wpdb->prefix, 'url' => get_option('home'), 'siteurl' => get_option('siteurl'), 'tables' => $tables);
}

function rivet_line($handle, $data) {
    $line = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
    if (strlen($line) > 8 * 1024 * 1024) { throw new RuntimeException('A database record exceeds the 8 MiB transfer limit.'); }
    if (fwrite($handle, $line) !== strlen($line)) { throw new RuntimeException('Cannot write database export. Check free disk space.'); }
}

function rivet_dump_batch($path, &$state, $selection = array(), $resume = false) {
    global $wpdb;
    if (!empty($state['complete'])) { return true; }
    if (!isset($state['tables'])) {
        $state = array('tables' => rivet_tables($selection), 'table' => 0, 'offset' => 0, 'bytes' => 0);
        $handle = fopen($path, $resume ? 'w+b' : 'x+b');
        if (!$handle) { throw new RuntimeException('Cannot create database export; destination must not exist.'); }
        chmod($path, 0600);
        rivet_line($handle, rivet_header($state['tables']));
        $state['bytes'] = ftell($handle);
        fclose($handle);
    }
    $handle = fopen($path, 'c+b');
    if (!$handle || !ftruncate($handle, $state['bytes']) || fseek($handle, $state['bytes']) !== 0) {
        throw new RuntimeException('Cannot resume database export.');
    }
    try {
        if ($state['table'] >= count($state['tables'])) {
            rivet_line($handle, array('type' => 'end'));
            $state['bytes'] = ftell($handle);
            $state['complete'] = true;
            return true;
        }
        $suffix = $state['tables'][$state['table']];
        $table = $wpdb->prefix . $suffix;
        if ($state['offset'] === 0) {
            $schema = $wpdb->get_row('SHOW CREATE TABLE ' . rivet_identifier($table), ARRAY_N);
            if (!$schema || $wpdb->last_error) { throw new RuntimeException('Cannot export table schema.'); }
            $schema = rivet_schema($schema[1], $table, $table);
            rivet_line($handle, array('type' => 'table', 'name' => $suffix, 'schema' => $schema));
        }
        $rows = $wpdb->get_results('SELECT * FROM ' . rivet_identifier($table) . ' LIMIT 100 OFFSET ' . (int) $state['offset'], ARRAY_A);
        if ($wpdb->last_error) { throw new RuntimeException('Cannot export table rows.'); }
        foreach ($rows as $row) {
            $encoded = array();
            foreach ($row as $key => $value) { $encoded[$key] = $value === null ? null : base64_encode((string) $value); }
            rivet_line($handle, array('type' => 'row', 'table' => $suffix, 'data' => $encoded));
        }
        $state['offset'] += count($rows);
        if (count($rows) < 100) { $state['table']++; $state['offset'] = 0; }
        $state['bytes'] = ftell($handle);
        return false;
    } finally { fclose($handle); }
}

function rivet_replace_text($text, $from, $to) {
    $map = is_array($from) ? $from : array($from => $to);
    $replace = array();
    foreach ($map as $old => $new) {
        if ($old !== '' && $old !== $new) {
            $replace[$old] = $new;
            $replace[str_replace('/', '\\/', $old)] = str_replace('/', '\\/', $new);
        }
    }
    return $replace ? strtr($text, $replace) : $text;
}

function rivet_serial_token($text, &$at, $from, $to, $depth = 0) {
    if ($depth > 64) { throw new RuntimeException('Serialized value nesting exceeds safe limit.'); }
    $remaining = substr($text, $at);
    if (preg_match('/^(N;|[bidrR]:[^;]*;)/', $remaining, $match)) { $at += strlen($match[0]); return $match[0]; }
    if (preg_match('/^s:(\d+):"/', $remaining, $match)) {
        $start = $at + strlen($match[0]);
        $length = (int) $match[1];
        if (substr($text, $start + $length, 2) !== '";') { throw new RuntimeException('Malformed serialized string.'); }
        $value = substr($text, $start, $length);
        $at = $start + $length + 2;
        $value = rivet_rewrite($value, $from, $to, $depth + 1);
        return 's:' . strlen($value) . ':"' . $value . '";';
    }
    if (preg_match('/^(a:(\d+):\{|O:\d+:"[^"]*":(\d+):\{)/', $remaining, $match)) {
        $count = (int) ($match[2] !== '' ? $match[2] : $match[3]);
        if ($count > 100000) { throw new RuntimeException('Serialized collection exceeds safe limit.'); }
        $result = $match[0];
        $at += strlen($result);
        for ($i = 0; $i < $count * 2; $i++) { $result .= rivet_serial_token($text, $at, $from, $to, $depth + 1); }
        if (substr($text, $at++, 1) !== '}') { throw new RuntimeException('Malformed serialized collection.'); }
        return $result . '}';
    }
    throw new RuntimeException('Unsupported serialized value; refusing to corrupt it.');
}

function rivet_rewrite($value, $from, $to, $depth = 0) {
    if (!is_string($value) || !$from || $from === $to || rivet_replace_text($value, $from, $to) === $value) { return $value; }
    if (preg_match('/^(?:[aOsC]:\d+:|[bidrR]:|N;)/', $value)) {
        $at = 0;
        $result = rivet_serial_token($value, $at, $from, $to, $depth);
        if ($at !== strlen($value)) { throw new RuntimeException('Trailing data in serialized value.'); }
        return $result;
    }
    return rivet_replace_text($value, $from, $to);
}

function rivet_import_batch($path, &$state, $job_id, $target_url) {
    global $wpdb;
    if (!$state) { $state = array('offset' => 0, 'tables' => array(), 'row' => 0); }
    $handle = fopen($path, 'rb');
    if (!$handle || fseek($handle, $state['offset']) !== 0) { throw new RuntimeException('Cannot read staged database.'); }
    try {
        for ($i = 0; $i < 100; $i++) {
            $line = fgets($handle, 8 * 1024 * 1024 + 1);
            if ($line === false || substr($line, -1) !== "\n") { throw new RuntimeException('Incomplete or oversized database export.'); }
            $record = json_decode($line, true, 512, JSON_THROW_ON_ERROR);
            if ($record['type'] === 'header') {
                if ($state['offset'] !== 0 || $i !== 0 || $record['version'] !== 1) { throw new RuntimeException('Invalid export header.'); }
                rivet_identifier($record['prefix']);
                rivet_validate_groups($record['tables']);
                $state['header'] = $record;
            } elseif ($record['type'] === 'table') {
                $suffix = $record['name'];
                if (!in_array($suffix, $state['header']['tables'], true)) { throw new RuntimeException('Unexpected table in export.'); }
                $stage = '_rvt_' . substr($job_id, 0, 24) . '_' . count($state['tables']);
                if (isset($state['tables'][$suffix])) { throw new RuntimeException('Duplicate table in export.'); }
                rivet_query('DROP TABLE IF EXISTS ' . rivet_identifier($stage));
                rivet_query(rivet_schema($record['schema'], $state['header']['prefix'] . $suffix, $stage));
                $state['tables'][$suffix] = $stage;
            } elseif ($record['type'] === 'row') {
                $suffix = $record['table'];
                if (!isset($state['tables'][$suffix]) || !$record['data']) { throw new RuntimeException('Row has no table schema.'); }
                $data = array();
                foreach ($record['data'] as $column => $encoded) {
                    rivet_identifier($column);
                    $value = $encoded === null ? null : base64_decode($encoded, true);
                    if ($value === false) { throw new RuntimeException('Invalid row encoding.'); }
                    $value = rivet_rewrite($value, array(($state['header']['siteurl'] ?? $state['header']['url']) => get_option('siteurl'), $state['header']['url'] => $target_url), null);
                    if (($suffix === 'options' && $column === 'option_name') || ($suffix === 'usermeta' && $column === 'meta_key')) {
                        if (is_string($value) && strpos($value, $state['header']['prefix']) === 0) { $value = $wpdb->prefix . substr($value, strlen($state['header']['prefix'])); }
                    }
                    $data[$column] = $value;
                }
                $columns = implode(',', array_map('rivet_identifier', array_keys($data)));
                $values = array();
                foreach ($data as $value) { $values[] = $value === null ? 'NULL' : "X'" . bin2hex($value) . "'"; }
                rivet_query('INSERT INTO ' . rivet_identifier($state['tables'][$suffix]) . ' (' . $columns . ') VALUES (' . implode(',', $values) . ')');
                $state['row']++;
            } elseif ($record['type'] === 'end') {
                if (array_diff($state['header']['tables'], array_keys($state['tables'])) || fgets($handle) !== false) { throw new RuntimeException('Export is incomplete or contains trailing records.'); }
                $state['offset'] = ftell($handle);
                return true;
            } else { throw new RuntimeException('Unknown database record.'); }
            $state['offset'] = ftell($handle);
        }
        return false;
    } finally { fclose($handle); }
}

function rivet_swap_tables(&$state, $job_id, $remove = array()) {
    global $wpdb;
    $existing = $wpdb->get_col('SHOW TABLES');
    $old = array();
    $rename = array();
    foreach ($state['tables'] as $suffix => $stage) {
        $target = $wpdb->prefix . $suffix;
        $previous = '_rvo_' . substr($job_id, 0, 24) . '_' . count($old);
        if (!in_array($stage, $existing, true)) {
            if (!in_array($target, $existing, true)) { throw new RuntimeException('Cannot recover an incomplete table switch.'); }
            continue;
        }
        if (in_array($target, $existing, true)) {
            $rename[] = rivet_identifier($target) . ' TO ' . rivet_identifier($previous);
            $old[] = $previous;
        }
        $rename[] = rivet_identifier($stage) . ' TO ' . rivet_identifier($target);
    }
    if (isset($state['tables']['options']) && in_array($state['tables']['options'], $existing, true)) {
        $table = rivet_identifier($state['tables']['options']);
        if ((int) $wpdb->get_var("SELECT COUNT(*) FROM $table WHERE option_name IN ('home', 'siteurl', 'active_plugins')") !== 3) { throw new RuntimeException('The imported options table is missing essential WordPress settings.'); }
        foreach (array('home', 'siteurl', 'upload_path', 'upload_url_path') as $key) {
            $value = get_option($key, '');
            rivet_query($wpdb->prepare("UPDATE $table SET option_value = %s WHERE option_name = %s", $value, $key));
        }
        $active = $wpdb->get_var("SELECT option_value FROM $table WHERE option_name = 'active_plugins'");
        $plugins = @unserialize($active ?: 'a:0:{}', array('allowed_classes' => false));
        if (!is_array($plugins) || array_filter($plugins, function ($p) { return !is_string($p); })) { throw new RuntimeException('Invalid active plugins option.'); }
        $plugins[] = 'rivet-connector/rivet-connector.php';
        rivet_query($wpdb->prepare("UPDATE $table SET option_value = %s WHERE option_name = 'active_plugins'", serialize(array_values(array_unique($plugins)))));
    }
    foreach ($remove as $suffix) {
        $target = $wpdb->prefix . $suffix;
        if (in_array($target, $existing, true)) {
            $previous = '_rvo_' . substr($job_id, 0, 24) . '_' . count($old);
            $rename[] = rivet_identifier($target) . ' TO ' . rivet_identifier($previous);
            $old[] = $previous;
        }
    }
    if ($rename) { rivet_query('RENAME TABLE ' . implode(', ', $rename)); }
    $state['old_tables'] = $old;
    wp_cache_flush();
}
