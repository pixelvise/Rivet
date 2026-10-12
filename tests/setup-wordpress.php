<?php

function wp_mail($to, $subject, $message, $headers = '', $attachments = array()) { return true; }
$root = $argv[1];
$socket = $argv[2];
$database = $argv[3];
$url = $argv[4];
$mode = $argv[5];
$db = new mysqli('localhost', 'root', '', '', 0, $socket);
$db->query('CREATE DATABASE `' . $database . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
$_SERVER['HTTP_HOST'] = parse_url($url, PHP_URL_HOST);
$_SERVER['REQUEST_URI'] = '/';
define('WP_INSTALLING', true);
require $root . '/wp-load.php';
require ABSPATH . 'wp-admin/includes/upgrade.php';
wp_install('Rivet ' . $mode, 'rivet_admin', 'nobody@example.test', false, '', bin2hex(random_bytes(24)));
update_option('home', $url);
update_option('siteurl', $url);
update_option('rivet_test_value', array('url' => $url . '/demo', 'mode' => $mode));
update_option('active_plugins', $mode === 'remote' ? array('rivet-connector/rivet-connector.php') : array());
$wpdb->query('CREATE TABLE `' . $wpdb->prefix . 'rivet_demo` (`id` bigint NOT NULL, `value` longtext, PRIMARY KEY (`id`)) ENGINE=InnoDB');
for ($i = 0; $i < 240; $i++) {
    $wpdb->insert($wpdb->prefix . 'rivet_demo', array('id' => $i, 'value' => serialize(array('url' => $url . '/row/' . $i, 'mode' => $mode))));
}
echo "WordPress fixture installed.\n";
