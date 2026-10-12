<?php

if (PHP_SAPI !== 'cli' && !defined('WP_CLI')) { exit(1); }
$parameters = isset($args) ? $args : array_slice($argv, 1);
$destination = $parameters[0] ?? '';
$selection = empty($parameters[1]) ? array() : explode(',', $parameters[1]);
if (!$destination) { fwrite(STDERR, "A destination path is required.\n"); exit(1); }
if (!defined('ABSPATH')) {
    $root = $parameters[2] ?? getcwd();
    if (!is_file($root . '/wp-load.php')) { fwrite(STDERR, "No WordPress installation found.\n"); exit(1); }
    define('WP_USE_THEMES', false);
    $_SERVER['HTTP_HOST'] = 'localhost';
    $_SERVER['REQUEST_URI'] = '/';
    require $root . '/wp-load.php';
}
require_once dirname(__DIR__) . '/plugin/rivet-connector/database.php';
try {
    $tables = rivet_tables($selection);
    rivet_validate_groups($tables);
    $state = array();
    while (!rivet_dump_batch($destination, $state, $tables)) {}
    echo "Rivet database export complete.\n";
} catch (Throwable $error) {
    fwrite(STDERR, $error->getMessage() . "\n");
    exit(1);
}
