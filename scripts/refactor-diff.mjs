#!/usr/bin/env node
/**
 * So hành vi đường tiền giữa HAI cây code bằng cùng một kịch bản (vòng 6, P2).
 *
 *   node scripts/refactor-diff.mjs --base ee43de6
 *
 * Vì sao cần: sau khi tách `webapp-app.mjs` thành 7 module (P5), bằng chứng cũ chỉ ở mức văn bản
 * ("mọi dòng gốc đều có mặt") hoặc mức tĩnh (chuỗi trong source). Cách duy nhất để biết việc tách
 * file có đổi HÀNH VI hay không là chạy cùng một kịch bản trên cả hai cây rồi so thứ đi ra dây:
 * calldata rút tiền, body `/api/bundle`, URL DELETE, trạng thái UI sau mỗi bước.
 *
 * Cách làm: `git show <ref>:<file>` lấy bản cũ ra `.freebuff/ab-<ref>/` (đã gitignore) — app cũ chỉ
 * import 3 file tương đối nên chỉ cần đúng chừng đó, không cần `git worktree`. Mỗi cây chạy trong
 * một TIẾN TRÌNH RIÊNG (chế độ `--run`) để không có state nào rò giữa hai lượt.
 *
 * Không nằm trong `npm run check`: nó cần lịch sử git (`git show`), mà CI checkout mặc định chỉ có
 * 1 commit. Đây là công cụ chạy tay — và là công cụ tái dùng cho mọi lần tách file sau này.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = "webapp-app.mjs";

function parseArgs(argv) {
  const args = { base: "ee43de6", run: null, keep: false, show: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") args.run = argv[i += 1];
    else if (arg === "--base") args.base = argv[i += 1];
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--show") args.show = true;
    else throw new Error(`tham số lạ: ${arg}`);
  }
  return args;
}

/** `git show <ref>:<file>` — ném lỗi rõ ràng nếu ref/file không tồn tại. */
function gitShow(ref, file) {
  try {
    return execFileSync("git", ["show", `${ref}:${file}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    throw new Error(`không lấy được ${file} từ ${ref} (ref/file sai, hoặc không có lịch sử git?)`);
  }
}

/** Lấy entry + MỌI import tương đối của nó (đệ quy) từ một ref vào một thư mục. */
function extractTree(ref, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const source = gitShow(ref, name);
    fs.writeFileSync(path.join(dir, name), source);
    for (const [, target] of source.matchAll(/(?:^|\s)(?:import|export)[^"']*?from\s*"(\.\/[^"]+)"/g)) {
      queue.push(target.slice(2));
    }
  }
  return [...seen];
}

/** Chạy kịch bản trên một cây, trong tiến trình riêng, trả về trace đã parse. */
function runScenario(entry) {
  const stdout = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--run", entry], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function countKind(trace, predicate) {
  return trace.steps.reduce((total, step) => total + step.calls.filter(predicate).length, 0);
}

/** Nhãn nhóm lời gọi: cùng loại + cùng method/URL thì mới nên so với nhau. */
function bucketOf(canonical) {
  const call = JSON.parse(canonical);
  return `${call.kind}:${call.method}:${call.url ?? ""}`;
}

/** Với hai chuỗi dài (vd calldata), chỉ ra VỊ TRÍ ký tự khác đầu tiên thay vì in cả chuỗi. */
function stringDiff(before, after) {
  const max = Math.min(before.length, after.length);
  let at = 0;
  while (at < max && before[at] === after[at]) at += 1;
  const from = Math.max(0, at - 8);
  const slice = (value) => value.slice(from, at + 16);
  const tail = before.length !== after.length ? ` (độ dài ${before.length} → ${after.length})` : "";
  return `khác từ ký tự ${at}${tail}: …${slice(before)}… → …${slice(after)}…`;
}

/** Đường dẫn lá đầu tiên khác nhau giữa hai giá trị JSON (để chỉ đích danh "khác ở đâu"). */
function leafDiffs(a, b, path = "", out = []) {
  if (a === b) return out;
  const isObject = (value) => value !== null && typeof value === "object";
  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      leafDiffs(a[key], b[key], path ? `${path}.${key}` : String(key), out);
    }
    return out;
  }
  const label = path || "(giá trị)";
  if (typeof a === "string" && typeof b === "string" && (a.length > 60 || b.length > 60)) {
    out.push(`${label} — ${stringDiff(a, b)}`);
    return out;
  }
  out.push(`${label}: cũ=${JSON.stringify(a)} → mới=${JSON.stringify(b)}`);
  return out;
}

/** So hai danh sách lời gọi trong cùng một bước, ưu tiên ghép cặp trong cùng nhóm. */
function compareCalls(name, oldCalls, newCalls, lines) {
  const onlyOld = oldCalls.filter((call) => !newCalls.includes(call));
  const onlyNew = newCalls.filter((call) => !oldCalls.includes(call));
  const newByBucket = new Map();
  for (const call of onlyNew) {
    const bucket = bucketOf(call);
    if (!newByBucket.has(bucket)) newByBucket.set(bucket, []);
    newByBucket.get(bucket).push(call);
  }
  const unmatchedOld = [];
  for (const call of onlyOld) {
    const bucket = bucketOf(call);
    const candidates = newByBucket.get(bucket) ?? [];
    if (candidates.length === 0) {
      unmatchedOld.push(call);
      continue;
    }
    const counterpart = candidates.shift();
    const diffs = leafDiffs(JSON.parse(call), JSON.parse(counterpart));
    for (const diff of diffs.slice(0, 3)) {
      lines.push(`bước "${name}" · ${bucket} → ${diff.slice(0, 260)}`);
    }
  }
  for (const call of unmatchedOld) lines.push(`bước "${name}": CHỈ CÓ Ở CÂY CŨ  ${call.slice(0, 160)}`);
  for (const list of newByBucket.values()) {
    for (const call of list) lines.push(`bước "${name}": CHỈ CÓ Ở CÂY MỚI  ${call.slice(0, 160)}`);
  }
}

function firstDifference(a, b, limit = 12) {
  const lines = [];
  const steps = Math.max(a.steps.length, b.steps.length);
  for (let i = 0; i < steps; i += 1) {
    const oldStep = a.steps[i];
    const newStep = b.steps[i];
    if (!oldStep || !newStep) {
      lines.push(`bước #${i}: ${oldStep ? `"${oldStep.name}" chỉ có ở cây cũ` : `"${newStep.name}" chỉ có ở cây mới`}`);
      continue;
    }
    if (oldStep.name !== newStep.name) lines.push(`bước #${i}: tên khác — "${oldStep.name}" vs "${newStep.name}"`);
    compareCalls(oldStep.name, oldStep.calls, newStep.calls, lines);
    for (const key of Object.keys(oldStep.obs)) {
      const before = oldStep.obs[key];
      const after = newStep.obs[key];
      if (before === after) continue;
      const diffs = leafDiffs(before, after).slice(0, 2);
      lines.push(`bước "${oldStep.name}" · obs.${key}:\n    cũ : ${String(before).slice(0, 220)}\n    mới: ${String(after).slice(0, 220)}`);
      for (const diff of diffs) lines.push(`    ↳ ${diff.slice(0, 200)}`);
    }
    if (lines.length >= limit) break;
  }
  return lines.slice(0, limit);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.run) {
    const { runWebappScenario, traceJson } = await import("../__tests__/helpers/webapp-scenario.mjs");
    const trace = await runWebappScenario({ entry: args.run });
    process.stdout.write(traceJson(trace));
    return;
  }

  const oldDir = path.join(ROOT, ".freebuff", `ab-${args.base}`);
  const oldEntry = path.join(oldDir, ENTRY);
  const newEntry = path.join(ROOT, ENTRY);

  console.log(`Cây cũ  : ${args.base}`);
  console.log(`Cây mới : HEAD (${ENTRY})`);
  const files = extractTree(args.base, oldDir);
  console.log(`Đã lấy  : ${files.length} file từ ${args.base} → ${path.relative(ROOT, oldDir)}`);

  let verdict = 0;
  try {
    const oldTrace = runScenario(oldEntry);
    const newTrace = runScenario(newEntry);

    const stats = (label, trace) => {
      console.log(
        `  ${label}: ${trace.steps.length} bước · ${trace.steps.reduce((n, s) => n + s.calls.length, 0)} lời gọi ` +
          `(eth_sendTransaction=${countKind(trace, (c) => c.includes('"eth_sendTransaction"'))}, ` +
          `POST /api/bundle=${countKind(trace, (c) => c.includes('"/api/bundle"'))}, ` +
          `DELETE /api/presign=${countKind(trace, (c) => c.includes('"DELETE"') && c.includes("/api/presign"))})`
      );
    };
    stats("cũ ", oldTrace);
    stats("mới", newTrace);

    if (args.show) console.log(JSON.stringify(newTrace, null, 2));

    const differences = firstDifference(oldTrace, newTrace, args.show ? 40 : 12);
    if (differences.length === 0) {
      console.log("\n✅ 0 khác biệt: cùng kịch bản ⇒ cùng calldata, cùng body, cùng trạng thái UI sau mỗi bước.");
    } else {
      console.log(`\n❌ ${differences.length} khác biệt:`);
      for (const line of differences) console.log(`  ${line}`);
      verdict = 1;
    }
  } finally {
    if (!args.keep) fs.rmSync(oldDir, { recursive: true, force: true });
  }
  process.exitCode = verdict;
}

await main();
