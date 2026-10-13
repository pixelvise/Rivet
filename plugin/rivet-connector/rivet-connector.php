<?php
/*
Plugin Name: Rivet Connector
Plugin URI: https://github.com/gomescraig/Rivet
Description: Direct, administrator-authorized WordPress deployment and private server snapshots.
Author: Craig Gomes
Author URI: https://craiggomes.com
License: MIT
Version: 0.2.0
Requires at least: 6.5
Requires PHP: 8.1
*/

if (!defined('ABSPATH')) { exit; }
require_once __DIR__ . '/storage.php';
require_once __DIR__ . '/database.php';
require_once __DIR__ . '/jobs.php';

function rivet_https() {
    $host = parse_url(home_url(), PHP_URL_HOST);
    return is_ssl() || in_array($host, array('localhost', '127.0.0.1', '::1', '[::1]'), true);
}

function rivet_device($request) {
    if (!rivet_https()) { return new WP_Error('rivet_https', 'Rivet requires HTTPS.', array('status' => 403)); }
    $header = $request->get_header('authorization');
    if (!preg_match('/^Bearer ([a-f0-9]{32})\.([a-f0-9]{64})$/D', $header ?: '', $match)) { return new WP_Error('rivet_auth', 'A Rivet device credential is required.', array('status' => 401)); }
    try {
        $devices = rivet_load(rivet_storage() . '/devices.json', array());
        $device = $devices[$match[1]] ?? null;
        if (!$device || !hash_equals($device['hash'], hash('sha256', $match[2]))) { return new WP_Error('rivet_auth', 'This device is not authorized.', array('status' => 401)); }
        $GLOBALS['rivet_device_id'] = $match[1];
        return true;
    } catch (Throwable $error) { return new WP_Error('rivet_storage', $error->getMessage(), array('status' => 503)); }
}

function rivet_confirm($body) {
    if (($body['confirm'] ?? '') !== untrailingslashit(site_url())) { throw new RuntimeException('Explicit confirmation must match the WordPress installation URL.'); }
}

function rivet_route($method, $pattern, $handler, $public = false) {
    register_rest_route('rivet/v1', $pattern, array(
        'methods' => $method,
        'permission_callback' => $public ? '__return_true' : 'rivet_device',
        'callback' => function ($request) use ($handler) {
            if (!rivet_https()) { return new WP_Error('rivet_https', 'Rivet requires HTTPS.', array('status' => 403)); }
            try {
                return rivet_lock(function () use ($request, $handler) {
                    if (strlen($request->get_body()) > 32 * 1024 * 1024) { throw new RuntimeException('Request exceeds the 32 MiB limit.'); }
                    $body = $request->get_json_params() ?: array();
                    global $wpdb;
                    $wpdb->suppress_errors(true);
                    return $handler($body, $request);
                });
            } catch (Throwable $error) { return new WP_Error('rivet_error', $error->getMessage(), array('status' => 400)); }
        },
    ));
}

add_action('rest_api_init', function () {
    rivet_route('GET', '/discovery', function () {
        return array('name' => 'rivet', 'protocol' => 1, 'version' => '0.2.0');
    }, true);
    rivet_route('POST', '/auth/start', function ($body) {
        if (!preg_match('/^[a-f0-9]{64}$/D', $body['challenge'] ?? '')) { throw new RuntimeException('Invalid device challenge.'); }
        $pending = rivet_load(rivet_storage() . '/pending.json', array());
        $pending = array_filter($pending, function ($entry) { return $entry['expires'] > time(); });
        if (count($pending) >= 20) { throw new RuntimeException('Too many pending requests. Try again in ten minutes.'); }
        $address = hash('sha256', $_SERVER['REMOTE_ADDR'] ?? 'unknown');
        foreach ($pending as $entry) { if ($entry['address'] === $address && $entry['created'] > time() - 5) { throw new RuntimeException('Wait before requesting another authorization.'); } }
        $id = bin2hex(random_bytes(16));
        $code = strtoupper(substr(bin2hex(random_bytes(5)), 0, 10));
        $pending[$id] = array('challenge' => $body['challenge'], 'label' => substr(sanitize_text_field($body['label'] ?? 'Rivet CLI'), 0, 100), 'code' => $code, 'expires' => time() + 600, 'created' => time(), 'address' => $address, 'status' => 'pending');
        rivet_save(rivet_storage() . '/pending.json', $pending);
        return array('id' => $id, 'code' => $code, 'expires_in' => 600, 'approval_url' => admin_url('tools.php?page=rivet&request=' . $id));
    }, true);
    rivet_route('POST', '/auth/poll', function ($body) {
        $id = rivet_id($body['id'] ?? '');
        $pending = rivet_load(rivet_storage() . '/pending.json', array());
        $entry = $pending[$id] ?? null;
        if (!$entry || $entry['expires'] < time()) { return array('status' => 'expired'); }
        if (!is_string($body['secret'] ?? null) || !hash_equals($entry['challenge'], hash('sha256', $body['secret']))) { throw new RuntimeException('Invalid device proof.'); }
        if ($entry['status'] === 'approved') {
            $secret = bin2hex(random_bytes(32));
            $device = bin2hex(random_bytes(16));
            $devices = rivet_load(rivet_storage() . '/devices.json', array());
            $devices[$device] = array('hash' => hash('sha256', $secret), 'label' => $entry['label'], 'created' => gmdate('c'), 'approved_by' => $entry['approved_by']);
            unset($pending[$id]);
            rivet_save(rivet_storage() . '/pending.json', $pending);
            rivet_save(rivet_storage() . '/devices.json', $devices);
            return array('status' => 'approved', 'token' => $device . '.' . $secret, 'device' => $device);
        }
        return array('status' => $entry['status']);
    }, true);
    rivet_route('POST', '/auth/revoke', function () {
        $devices = rivet_load(rivet_storage() . '/devices.json', array());
        unset($devices[$GLOBALS['rivet_device_id']]);
        rivet_save(rivet_storage() . '/devices.json', $devices);
        return array('revoked' => true);
    });
    rivet_route('POST', '/plan', function ($body) {
        $manifest = rivet_manifest($body['files'] ?? array(), $body['database'] ?? null);
        $changed = array();
        $bytes = 0;
        foreach ($manifest as $path => $entry) {
            if ($path === '@database') { continue; }
            $target = rivet_target($path);
            if (!is_file($target) || !hash_equals($entry['sha256'], hash_file('sha256', $target))) { $changed[] = $path; $bytes += $entry['size']; }
        }
        return array('target' => untrailingslashit(site_url()), 'changed' => $changed, 'bytes' => $bytes, 'replace_tables' => $body['database']['tables'] ?? array(), 'upload_batch' => true, 'warnings' => array('Table replacement is not a row-level merge. Plugin table relationships are not inferred.', 'Backups require maintenance mode and private disk space. Pause external writers and scheduled hosting tasks.', 'File deployment overlays managed paths; it does not delete remote-only files.', 'WordPress core, plugin, and theme version compatibility must be checked on staging.'));
    });
    rivet_route('POST', '/deployments', function ($body) {
        rivet_confirm($body);
        $manifest = rivet_manifest($body['files'] ?? array(), $body['database'] ?? null);
        if (disk_free_space(rivet_storage()) < array_sum(array_column($manifest, 'size')) * 1.2 + 10485760) { throw new RuntimeException('Insufficient space to stage deployment.'); }
        $id = bin2hex(random_bytes(16));
        $directory = rivet_deployment_path($id);
        mkdir($directory, 0700);
        rivet_save($directory . '/manifest.json', array('id' => $id, 'owner' => $GLOBALS['rivet_device_id'], 'files' => $body['files'] ?? array(), 'database' => $body['database'] ?? null, 'entries' => $manifest, 'created' => gmdate('c')));
        return array('id' => $id);
    });
    rivet_route('POST', '/deployments/(?P<id>[a-f0-9]{32})/chunk', function ($body, $request) {
        $directory = rivet_deployment_path($request['id']);
        $manifest = rivet_load($directory . '/manifest.json');
        if (!$manifest || $manifest['owner'] !== $GLOBALS['rivet_device_id'] || isset($manifest['job'])) { throw new RuntimeException('Deployment is not writable by this device.'); }
        return rivet_receive_chunk($directory, $manifest, $body);
    });
    rivet_route('POST', '/deployments/(?P<id>[a-f0-9]{32})/batch', function ($body, $request) {
        $directory = rivet_deployment_path($request['id']);
        $manifest = rivet_load($directory . '/manifest.json');
        if (!$manifest || $manifest['owner'] !== $GLOBALS['rivet_device_id'] || isset($manifest['job'])) { throw new RuntimeException('Deployment is not writable by this device.'); }
        return rivet_receive_batch($directory, $manifest, $body['chunks'] ?? null);
    });
    rivet_route('POST', '/deployments/(?P<id>[a-f0-9]{32})/commit', function ($body, $request) {
        rivet_confirm($body);
        $directory = rivet_deployment_path($request['id']);
        $manifest = rivet_load($directory . '/manifest.json');
        if (!$manifest || $manifest['owner'] !== $GLOBALS['rivet_device_id']) { throw new RuntimeException('Deployment not found for this device.'); }
        if (isset($manifest['job'])) { return rivet_job_public(rivet_load(rivet_job_path($manifest['job']))); }
        foreach ($manifest['entries'] as $entry) {
            $file = $directory . '/' . hash('sha256', $entry['path']);
            if (!is_file($file) || filesize($file) !== $entry['size'] || !hash_equals($entry['sha256'], hash_file('sha256', $file))) { throw new RuntimeException('Upload is incomplete or has an invalid checksum.'); }
        }
        $job = rivet_new_job('deploy', $request['id'], $request['id']);
        $manifest['job'] = $job['id'];
        rivet_save($directory . '/manifest.json', $manifest);
        return rivet_job_public($job);
    });
    rivet_route('GET', '/backups', function () {
        $backups = array();
        foreach (glob(rivet_storage() . '/snapshot-*/manifest.json') as $file) {
            $snapshot = rivet_load($file);
            if (($snapshot['status'] ?? '') === 'complete') { $backups[] = array('id' => $snapshot['id'], 'created' => $snapshot['created'], 'files' => count($snapshot['files']), 'tables' => count($snapshot['tables']), 'database_bytes' => $snapshot['database']['size']); }
        }
        usort($backups, function ($a, $b) { return strcmp($b['created'], $a['created']); });
        return $backups;
    });
    rivet_route('POST', '/backups', function ($body) {
        if (($body['action'] ?? '') === 'restore') {
            rivet_confirm($body);
            return rivet_job_public(rivet_new_job('restore', rivet_id($body['snapshot'] ?? ''), $body['request_id'] ?? null));
        }
        if (($body['action'] ?? '') !== 'create') { throw new RuntimeException('Unknown backup action.'); }
        return rivet_job_public(rivet_new_job('backup', null, $body['request_id'] ?? null));
    });
    rivet_route('GET', '/jobs/(?P<id>[a-f0-9]{32})', function ($body, $request) {
        $job = rivet_load(rivet_job_path($request['id']));
        if (!$job) { throw new RuntimeException('Job not found.'); }
        return rivet_job_public($job);
    });
    rivet_route('POST', '/jobs/(?P<id>[a-f0-9]{32})/step', function ($body, $request) { return rivet_job_step($request['id']); });
    rivet_route('POST', '/jobs/(?P<id>[a-f0-9]{32})/cancel', function ($body, $request) { return rivet_cancel_job($request['id']); });
});

add_action('admin_menu', function () { add_management_page('Rivet', 'Rivet', 'manage_options', 'rivet', 'rivet_admin'); });

function rivet_admin() {
    if (!current_user_can('manage_options') || !current_user_can('install_plugins')) { wp_die('Administrator access is required.'); }
    echo '<div class="wrap"><h1>Rivet</h1><p>Authorize only requests you started in your terminal. An approved device can replace this site’s code and database. Device grants survive database restores; revoke them here when no longer needed.</p>';
    try {
        if (!rivet_https()) { throw new RuntimeException('HTTPS is required.'); }
        rivet_lock(function () {
            if ($_SERVER['REQUEST_METHOD'] === 'POST') {
                check_admin_referer('rivet-device');
                if (isset($_POST['revoke'])) {
                    $devices = rivet_load(rivet_storage() . '/devices.json', array());
                    unset($devices[rivet_id(wp_unslash($_POST['revoke']))]);
                    rivet_save(rivet_storage() . '/devices.json', $devices);
                    echo '<p>Device revoked.</p>';
                } elseif (isset($_POST['request'], $_POST['decision'])) {
                    $id = rivet_id(wp_unslash($_POST['request']));
                    $pending = rivet_load(rivet_storage() . '/pending.json', array());
                    if (!isset($pending[$id]) || $pending[$id]['expires'] < time() || $pending[$id]['status'] !== 'pending') { throw new RuntimeException('Request expired or already used.'); }
                    $approve = $_POST['decision'] === 'approve';
                    if ($approve && empty($_POST['verified'])) { throw new RuntimeException('Confirm that the code matches your terminal.'); }
                    $pending[$id]['status'] = $approve ? 'approved' : 'denied';
                    $pending[$id]['approved_by'] = get_current_user_id();
                    rivet_save(rivet_storage() . '/pending.json', $pending);
                    echo '<p>Decision saved. Return to your terminal.</p>';
                }
            }
            if (isset($_GET['request'])) {
                $id = rivet_id(wp_unslash($_GET['request']));
                $pending = rivet_load(rivet_storage() . '/pending.json', array());
                $entry = $pending[$id] ?? null;
                if ($entry && $entry['expires'] > time() && $entry['status'] === 'pending') {
                    echo '<h2>Connect ' . esc_html($entry['label']) . '</h2><p>Verification code: <strong>' . esc_html($entry['code']) . '</strong></p><form method="post">';
                    wp_nonce_field('rivet-device');
                    echo '<input type="hidden" name="request" value="' . esc_attr($id) . '"><p><label><input type="checkbox" name="verified" value="1"> I started this request and the code matches my terminal.</label></p><button class="button button-primary" name="decision" value="approve">Authorize device</button> <button class="button" name="decision" value="deny">Deny</button></form>';
                }
            }
            echo '<h2>Connected devices</h2>';
            foreach (rivet_load(rivet_storage() . '/devices.json', array()) as $id => $device) {
                echo '<form method="post"><p>' . esc_html($device['label'] . ' — ' . $device['created']) . ' ';
                wp_nonce_field('rivet-device');
                echo '<button class="button" name="revoke" value="' . esc_attr($id) . '">Revoke</button></p></form>';
            }
        });
    } catch (Throwable $error) { echo '<p>' . esc_html($error->getMessage()) . '</p>'; }
    echo '</div>';
}

add_action('init', function () {
    try {
        $active = rivet_load(rivet_storage() . '/active.json');
        if (!$active) { return; }
        $route = isset($_GET['rest_route']) ? wp_unslash($_GET['rest_route']) : '';
        $uri = $_SERVER['REQUEST_URI'] ?? '';
        if (strpos($route, '/rivet/v1/') === 0 || preg_match('#/wp-json/rivet/v1/#', $uri)) { return; }
        status_header(503);
        header('Retry-After: 60');
        wp_die('Rivet maintenance in progress. Resume the active job from the Rivet CLI.', 'Maintenance', array('response' => 503));
    } catch (Throwable $error) {
        if (is_admin()) { add_action('admin_notices', function () use ($error) { echo '<div class="notice notice-error"><p>Rivet: ' . esc_html($error->getMessage()) . '</p></div>'; }); }
    }
}, -999);
