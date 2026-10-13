<?php

require dirname(__DIR__) . '/plugin/rivet-connector/storage.php';
require dirname(__DIR__) . '/plugin/rivet-connector/database.php';
require dirname(__DIR__) . '/plugin/rivet-connector/jobs.php';
$count = 0;
function check($condition, $name) {
    global $count;
    if (!$condition) { throw new RuntimeException('FAIL: ' . $name); }
    $count++;
    echo 'PASS: ' . $name . "\n";
}
function rejects($callback, $name) {
    try { $callback(); } catch (RuntimeException $error) { check(true, $name); return; }
    check(false, $name);
}

foreach (array('../wp-config.php', '/index.php', 'wp-content/plugins/rivet-connector/a.php', 'wp-content/uploads/../../x.php', 'wp-content/uploads/a\\b.php', 'wp-content/database/.ht.sqlite', 'wp-content/db.php', 'wp-content/mu-plugins/sqlite-loader.php', 'wp-content/uploads/x.sql', '.env', 'wp-content/mu-plugins/99-studio-loader.php', 'wp-content/mu-plugins/0-auto-login.php', 'wp-content/mu-plugins/0-studio-admin-api.php') as $path) { check(!rivet_allowed_path($path), 'reject path ' . $path); }
foreach (array('index.php', 'wp-content/plugins/demo/main.php', 'wp-content/themes/demo/style.css', 'wp-includes/version.php') as $path) { check(rivet_allowed_path($path), 'allow path ' . $path); }
rejects(function () { rivet_id('../x'); }, 'reject invalid job IDs');
rejects(function () { rivet_identifier('x`; DROP TABLE x'); }, 'reject identifier injection');
rejects(function () { rivet_validate_groups(array('posts')); }, 'require content dependencies');
rejects(function () { rivet_validate_groups(array('postmeta')); }, 'require parent tables');
rejects(function () { rivet_validate_groups(array('options')); }, 'require users when deploying options');
rivet_validate_groups(array('users', 'usermeta'));
check(true, 'accept user table group');

$from = 'http://local.test';
$to = 'https://production.example.com';
$original = array('url' => $from . '/hello', 'nested' => serialize(array('url' => $from)), 'utf8' => 'déjà ' . $from);
$actual = unserialize(rivet_rewrite(serialize($original), $from, $to), array('allowed_classes' => false));
check($actual['url'] === $to . '/hello', 'serialized URL replacement');
check(unserialize($actual['nested'])['url'] === $to, 'nested serialized URL replacement');
check($actual['utf8'] === 'déjà ' . $to, 'serialized byte lengths');
check(rivet_rewrite(json_encode(array('url' => $from)), $from, $to) === json_encode(array('url' => $to)), 'JSON escaped URLs');
check(rivet_rewrite("binary\0stuff", $from, $to) === "binary\0stuff", 'preserve binary values');
$overlap = rivet_rewrite(serialize(array($from . '/wp/page', $from . '/page')), array($from . '/wp' => $from . '/live/wp', $from => $from . '/live'), null);
check(unserialize($overlap) === array($from . '/live/wp/page', $from . '/live/page'), 'replace overlapping home/site URLs once without cascades');
rejects(function () use ($from, $to) { rivet_rewrite('s:999:"' . $from . '";', $from, $to); }, 'reject malformed serialization');
class RivetTestPayload {
    public $url;
    public function __wakeup() { throw new RuntimeException('Object must not be instantiated'); }
}
$object = new RivetTestPayload();
$object->url = $from;
$output = rivet_rewrite(serialize($object), $from, $to);
check(strpos($output, $to) !== false, 'rewrite serialized object without object instantiation');
$shared = array('url' => $from);
$references = array(&$shared, &$shared);
$changed = unserialize(rivet_rewrite(serialize($references), $from, $to));
check($changed[0]['url'] === $to && $changed[1]['url'] === $to, 'preserve serialized references');

$sql = 'CREATE TABLE `wp_demo` (`id` bigint NOT NULL, `value` text, PRIMARY KEY (`id`)) ENGINE=InnoDB';
check(strpos(rivet_schema($sql, 'wp_demo', '_rvt_test'), 'CREATE TABLE `_rvt_test`') === 0, 'stage schemas under generated names');
check(strpos(rivet_schema('DROP TABLE IF EXISTS `wp_demo`; ' . $sql . ';', 'wp_demo', '_rvt_test'), 'CREATE TABLE') === 0, 'accept Studio schema preamble');
foreach (array($sql . '; DROP TABLE users', 'CREATE VIEW `wp_demo` AS SELECT 1', 'CREATE TABLE `wp_demo` (`id` int, FOREIGN KEY (`id`) REFERENCES `x` (`id`))', $sql . " DATA DIRECTORY='/tmp'", 'CREATE TABLE `other` (`id` int)') as $bad) {
    rejects(function () use ($bad) { rivet_schema($bad, 'wp_demo', '_rvt_test'); }, 'reject unsafe or unsupported schema');
}

$root = sys_get_temp_dir() . '/rivet-php-' . bin2hex(random_bytes(8));
mkdir($root, 0700);
mkdir($root . '/public');
mkdir($root . '/private', 0700);
define('ABSPATH', $root . '/public/');
define('RIVET_STORAGE_DIR', $root . '/private/rivet');
$_SERVER['DOCUMENT_ROOT'] = $root . '/public';
check(rivet_storage() === realpath($root . '/private/rivet'), 'private storage outside document root');
mkdir($root . '/public/wp-content');
symlink($root . '/private', $root . '/public/wp-content/uploads');
rejects(function () { rivet_target('wp-content/uploads/secret.php'); }, 'reject symlink destination');
rivet_save(rivet_storage() . '/state.json', array('value' => 123));
check(rivet_load(rivet_storage() . '/state.json')['value'] === 123, 'atomic state roundtrip');
check((fileperms(rivet_storage() . '/state.json') & 0777) === 0600, 'private state permissions');
$directory = rivet_storage();
$upload_path = 'wp-content/uploads/test.txt';
$manifest = array('entries' => array($upload_path => array('size' => 4)));
$chunk = array('path' => $upload_path, 'offset' => 0, 'data' => base64_encode('test'));
rivet_receive_batch($directory, $manifest, array($chunk, $chunk));
check(file_get_contents($directory . '/' . hash('sha256', $upload_path)) === 'test', 'batch retries do not duplicate bytes');
rejects(function () use ($directory, $manifest, $chunk) { rivet_receive_batch($directory, $manifest, array_fill(0, 21, $chunk)); }, 'bound batch file count');
rejects(function () use ($directory, $manifest, $chunk) { $chunk['data'] = base64_encode(str_repeat('x', 200000)); rivet_receive_batch($directory, $manifest, array($chunk, $chunk, $chunk)); }, 'bound batch payload size');
rejects(function () use ($directory, $manifest, $chunk) { $chunk['data'] = base64_encode('oops'); rivet_receive_batch($directory, $manifest, array($chunk)); }, 'reject conflicting batch retries');
rejects(function () use ($directory, $manifest, $chunk) { $chunk['path'] = '../wp-config.php'; rivet_receive_batch($directory, $manifest, array($chunk)); }, 'reject paths absent from authorized manifest');
$public = rivet_job_public(array('id' => 'test', 'phase' => 'backup-files', 'cursor' => 2, 'files' => array(1, 2, 3), 'data_path' => '/private/export'));
check($public['details'] === array('completed' => 2, 'total' => 3, 'unit' => 'files'), 'publish real backup counts');
check(!isset($public['data_path']), 'do not expose private job paths');
unlink($directory . '/' . hash('sha256', $upload_path));
unlink(rivet_storage() . '/state.json');
unlink($root . '/public/wp-content/uploads');
rmdir($root . '/public/wp-content');
rmdir(rivet_storage());
rmdir($root . '/private');
rmdir($root . '/public');
rmdir($root);
echo "$count PHP checks passed.\n";
