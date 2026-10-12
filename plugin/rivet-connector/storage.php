<?php

function rivet_inside($path, $root) {
    return $path === $root || strpos($path, rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR) === 0;
}

function rivet_storage() {
    static $directory;
    if ($directory) { return $directory; }
    $wp = realpath(ABSPATH);
    $document = isset($_SERVER['DOCUMENT_ROOT']) ? realpath($_SERVER['DOCUMENT_ROOT']) : false;
    $candidate = defined('RIVET_STORAGE_DIR') ? RIVET_STORAGE_DIR : dirname($document ?: $wp) . '/.rivet-' . substr(hash('sha256', $wp), 0, 16);
    $parent = realpath(dirname($candidate));
    if (!$parent || is_link($candidate) || rivet_inside($parent, $wp) || ($document && rivet_inside($parent, $document))) {
        throw new RuntimeException('Set RIVET_STORAGE_DIR in wp-config.php to a private writable directory outside every web document root.');
    }
    if (!is_dir($candidate) && !mkdir($candidate, 0700)) { throw new RuntimeException('Cannot create private Rivet storage. Configure RIVET_STORAGE_DIR.'); }
    $candidate = realpath($candidate);
    if (!$candidate || rivet_inside($candidate, $wp) || ($document && rivet_inside($candidate, $document)) || !is_writable($candidate)) {
        throw new RuntimeException('Rivet storage must be writable and outside the public web directory.');
    }
    chmod($candidate, 0700);
    $directory = $candidate;
    return $directory;
}

function rivet_save($path, $data) {
    $temp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
    $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    if (file_put_contents($temp, $json, LOCK_EX) !== strlen($json)) { throw new RuntimeException('Cannot save Rivet state. Check disk space.'); }
    chmod($temp, 0600);
    if (!rename($temp, $path)) { throw new RuntimeException('Cannot atomically save Rivet state.'); }
}

function rivet_load($path, $default = null) {
    if (!is_file($path)) { return $default; }
    return json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
}

function rivet_lock($callback) {
    $file = fopen(rivet_storage() . '/lock', 'c');
    if (!$file || !flock($file, LOCK_EX | LOCK_NB)) { throw new RuntimeException('Another Rivet request is running. Retry shortly.'); }
    try { return $callback(); }
    finally { flock($file, LOCK_UN); fclose($file); }
}

function rivet_id($id) {
    if (!is_string($id) || !preg_match('/^[a-f0-9]{32}$/D', $id)) { throw new RuntimeException('Invalid Rivet identifier.'); }
    return $id;
}

function rivet_allowed_path($path) {
    if (!is_string($path) || strlen($path) > 500 || preg_match('/[\\\\\x00-\x1f\x7f:]/', $path)) { return false; }
    $parts = explode('/', $path);
    $blocked = array('node_modules', 'vendor-bin', 'cache', 'upgrade', 'upgrade-temp-backup', 'backups', 'ai1wm-backups', 'updraft', 'wflogs', 'database', 'rivet-connector', 'sqlite-database-integration', 'sqlite-database-integration-main');
    foreach ($parts as $part) { if ($part === '' || $part[0] === '.' || in_array(strtolower($part), $blocked, true)) { return false; } }
    if (strpos($path, 'wp-content/mu-plugins/') === 0 && preg_match('/^(99-studio-loader\.php|0-(allowed-redirect-hosts|auto-login|check-theme-availability|deactivate-jetpack-modules|disable-auto-updates|enable-auto-updates|http-request-timeout|https-for-reverse-proxy|permalinks|redirect-to-siteurl-constant|sqlite-command|studio-admin-api|studio-cli-commands|suppress-dns-get-record-warnings|thumbnails|tmp-fix-hide-plugins-spinner|tmp-fix-qm-plugin-sapi|wp-admin-trailing-slash|32bit-integer-warnings|dns-functions|sqlite|wp-config-constants-polyfill)\.php)$/iD', $parts[2])) { return false; }
    if (preg_match('/\.(sql|sqlite|sqlite3|log|bak|env|pem|key)$/i', $path) || preg_match('#(^|/)wp-config[^/]*$#i', $path)) { return false; }
    if (count($parts) === 1) { return in_array($path, array('index.php', 'wp-activate.php', 'wp-blog-header.php', 'wp-comments-post.php', 'wp-cron.php', 'wp-links-opml.php', 'wp-load.php', 'wp-login.php', 'wp-mail.php', 'wp-settings.php', 'wp-signup.php', 'wp-trackback.php', 'xmlrpc.php'), true); }
    if (in_array($parts[0], array('wp-admin', 'wp-includes'), true)) { return true; }
    foreach ($parts as $part) { if (strpos($part, 'sqlite-') === 0) { return false; } }
    return $parts[0] === 'wp-content' && in_array($parts[1], array('plugins', 'themes', 'uploads', 'mu-plugins', 'languages'), true);
}

function rivet_target($relative) {
    if (!rivet_allowed_path($relative)) { throw new RuntimeException('Protected or unsafe deployment path.'); }
    $root = realpath(ABSPATH);
    $path = $root;
    foreach (explode('/', $relative) as $part) {
        $path .= DIRECTORY_SEPARATOR . $part;
        if (is_link($path)) { throw new RuntimeException('Symlinked deployment paths are not supported.'); }
        if (file_exists($path) && !rivet_inside(realpath($path), $root)) { throw new RuntimeException('Path escapes the WordPress root.'); }
    }
    return $path;
}

function rivet_files() {
    $result = array();
    $walk = function ($relative) use (&$walk, &$result) {
        $full = rtrim(ABSPATH, '/\\') . '/' . $relative;
        if (is_link($full)) { return; }
        if (is_dir($full)) {
            if ($relative !== '' && !rivet_allowed_path($relative) && !in_array($relative, array('wp-admin', 'wp-includes', 'wp-content'), true)) { return; }
            $names = scandir($full);
            if ($names === false) { throw new RuntimeException('Cannot enumerate site files.'); }
            foreach ($names as $name) {
                if ($name !== '.' && $name !== '..') { $walk($relative === '' ? $name : $relative . '/' . $name); }
            }
        } elseif (is_file($full) && rivet_allowed_path($relative)) {
            $hash = hash_file('sha256', $full);
            if (!$hash) { throw new RuntimeException('Cannot read site file.'); }
            $result[] = array('path' => $relative, 'size' => filesize($full), 'sha256' => $hash);
        }
    };
    $walk('');
    return $result;
}

function rivet_manifest($files, $database = null) {
    if (!is_array($files) || count($files) > 100000) { throw new RuntimeException('Invalid or oversized file manifest.'); }
    $seen = array();
    foreach (array_merge($files, $database ? array($database) : array()) as $entry) {
        $path = $entry['path'] ?? '';
        if (($path !== '@database' && !rivet_allowed_path($path)) || isset($seen[$path])) { throw new RuntimeException('Invalid or duplicate manifest path.'); }
        if ($path === '@database' && (!$database || $entry !== $database)) { throw new RuntimeException('Invalid database manifest.'); }
        if (!isset($entry['size']) || !is_int($entry['size']) || $entry['size'] < 0 || $entry['size'] > 20 * 1024 * 1024 * 1024 || !preg_match('/^[a-f0-9]{64}$/D', $entry['sha256'] ?? '')) { throw new RuntimeException('Invalid file size or checksum.'); }
        $seen[$path] = $entry;
    }
    if ($database) { rivet_validate_groups($database['tables'] ?? array()); }
    return $seen;
}

function rivet_copy($source, $target, $hash, $mode = 0600) {
    if (!is_file($source) || !hash_equals($hash, hash_file('sha256', $source))) { throw new RuntimeException('Source checksum mismatch.'); }
    if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0755, true)) { throw new RuntimeException('Cannot create destination directory.'); }
    $temp = rivet_storage() . '/copy-' . bin2hex(random_bytes(8));
    if (!copy($source, $temp) || !hash_equals($hash, hash_file('sha256', $temp))) { throw new RuntimeException('Copy failed or disk is full.'); }
    chmod($temp, $mode);
    if (!rename($temp, $target)) { throw new RuntimeException('Atomic file replacement failed. Storage and WordPress must share a filesystem.'); }
}
