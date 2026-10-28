// Fetches the pinned VictoriaTraces release into vendor/ and checks it against the checksum kept here (ADR 0027,
// 0064). Tests run against it, and the image is built with the same script, so they use the same binary.
//
//   node scripts/victoriatraces.ts                 # this machine, into vendor/victoria-traces
//   node scripts/victoriatraces.ts linux arm64 out  # another platform, into out/victoria-traces
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const VERSION = "v0.12.1";
/** sha256 of each release archive, from victoria-traces-<platform>-<version>_checksums.txt. Change with VERSION. */
const SHA256: Record<string, string> = {
  "linux-amd64": "966c01559cc3f3452bae136106ec24c484f2383c4c4f9b51ebf2f6c4163721ba",
  "linux-arm64": "c08454c06f6db0a22f70c7d35ab0611e9dfee9db4143228ea56f4987399fece3",
  "darwin-arm64": "e706b527c55551af65faee1db8b45e0e094d36f79d5e2482bf427ca04b350b63",
};

const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };
const [os = process.platform, arch = ARCH[process.arch] ?? process.arch, outDir = new URL("../vendor", import.meta.url).pathname] = process.argv.slice(2);
const platform = `${os}-${arch}`;
const binary = join(outDir, "victoria-traces");
const stamp = join(outDir, "victoria-traces.version");

if (existsSync(binary) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${VERSION} ${platform}`) process.exit(0);
const sum = SHA256[platform];
if (!sum) {
  console.error(`No pinned checksum for VictoriaTraces ${VERSION} on ${platform}. Add it to scripts/victoriatraces.ts.`);
  process.exit(1);
}
const name = `victoria-traces-${platform}-${VERSION}.tar.gz`;
const res = await fetch(`https://github.com/VictoriaMetrics/VictoriaTraces/releases/download/${VERSION}/${name}`);
if (!res.ok) throw new Error(`${name}: ${res.status}`);
const archive = Buffer.from(await res.arrayBuffer());
const got = createHash("sha256").update(archive).digest("hex");
if (got !== sum) throw new Error(`${name}: sha256 is ${got}, expected ${sum}`);

const dir = mkdtempSync(join(tmpdir(), "victoria-traces-"));
try {
  writeFileSync(join(dir, name), archive);
  execFileSync("tar", ["-xzf", join(dir, name), "-C", dir]);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(dir, "victoria-traces-prod"), binary);
  chmodSync(binary, 0o755);
  writeFileSync(stamp, `${VERSION} ${platform}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`VictoriaTraces ${VERSION} for ${platform} in ${binary}`);
