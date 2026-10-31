"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { spawnSync } = require("node:child_process");
test("Pi installer verifies the chosen release before writes and produces a stable keyring-enabled desktop launcher", { skip: process.platform !== "linux" }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kai-installer-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.resolve(__dirname, "../../scripts/install-linux.sh");
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
  const check = String.raw`
import hashlib, json, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1])
source = pathlib.Path(sys.argv[2]).read_text()
body = source.split("<<'PY'\n",1)[1].rsplit('\nPY',1)[0]
home = root / "Pi's home with spaces"
home.mkdir()
stage = root / 'stage'
stage.mkdir()
install = home / 'Applications/KAI-Core'
install.mkdir(parents=True)
payload = b'\x7fELF\x02\x01\x01\x00AI\x02\x00test image'
digest = hashlib.sha256(payload).hexdigest()
name = 'KAI-Core-Beta-0.7.14-linux-arm64.AppImage'
release = {'tag_name':'v0.7.14','draft':False,'prerelease':False,'assets':[{'name':name,'state':'uploaded','size':len(payload),'digest':'sha256:'+digest,'browser_download_url':'https://github.com/therexdev/kai-core/releases/download/v0.7.14/'+name}]}
def prepare(value):
    (stage / 'release.json').write_text(json.dumps(value))
    (stage / name).unlink(missing_ok=True)
def run():
    scoped = body.replace('home = Path.home()', 'home = Path('+repr(str(home))+')')
    scoped = scoped.replace("data = Path(os.environ.get('XDG_DATA_HOME') or home / '.local/share')", "data = home / '.local/share'")
    # Only intercept external platform boundaries; all validation and writes are real.
    intercept = '''
real_run = subprocess.run
def fixture_run(args, **kwargs):
    if args[0] == 'curl':
        Path(args[args.index('--output')+1]).write_bytes(PAYLOAD)
        return subprocess.CompletedProcess(args,0)
    raise FileNotFoundError(args[0])
subprocess.run = fixture_run
'''.replace('PAYLOAD',repr(payload))
    scoped = scoped.replace('stage = Path(sys.argv[1])',intercept+'\nstage = Path(sys.argv[1])')
    return subprocess.run([sys.executable,'-',str(stage),str(install),'aarch64'],input=scoped,text=True,capture_output=True)
prepare(release)
result = run()
assert result.returncode == 0, result.stderr
binary = install / 'KAI-Core.AppImage'
assert binary.read_bytes() == payload
launcher = home / '.local/bin/kai-core-beta'
text = launcher.read_text()
assert '--password-store=gnome-libsecret' in text
assert 'KAI_CORE_APPIMAGE_PATH=' in text
assert '--no-sandbox' not in text
assert 'APPIMAGE_EXTRACT_AND_RUN=1' in text
assert (home / 'Desktop/KAI Core Beta.desktop').read_text() == (home / '.local/share/applications/kai-core-beta.desktop').read_text()
# Reinstall keeps the same launcher and shortcut paths.
prepare(release)
assert run().returncode == 0
assert text == launcher.read_text()
# A tampered checksum or nonofficial URL cannot replace the installed app.
for key, value in [('digest','sha256:'+'0'*64),('browser_download_url','https://evil.example/app')]:
    changed = json.loads(json.dumps(release)); changed['assets'][0][key] = value
    prepare(changed)
    assert run().returncode != 0
    assert binary.read_bytes() == payload
    assert launcher.read_text() == text
print('Installer checks passed')
`;
  const result = spawnSync("python3", ["-c", check, root, script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
