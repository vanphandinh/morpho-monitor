#!/usr/bin/env node
/**
 * In trace kịch bản đường tiền của MỘT cây ra stdout dưới dạng JSON (vòng 6, P3).
 *
 *   node scripts/webapp-trace.mjs                                  # cây hiện tại
 *   node scripts/webapp-trace.mjs --entry .freebuff/ab-05b8342/webapp-app.mjs
 *   node scripts/webapp-trace.mjs --overrides '{"rpc":{"txVisible":false}}'
 *   node scripts/webapp-trace.mjs --out __tests__/fixtures/webapp-flows-trace.json
 *   node scripts/webapp-trace.mjs --overrides {rpc:{txVisible:false}} --cap-timers 1
 *
 * Vì sao là script riêng chứ không gọi thẳng trong test: kịch bản cần một tiến trình **mới** cho mỗi
 * biến thể. Module ESM được cache theo URL, nên chạy lần thứ hai trong cùng tiến trình sẽ không
 * evaluate lại `webapp-state.mjs`/`webapp-app.mjs` — state cũ còn nguyên và kết quả vô nghĩa. Tách
 * tiến trình cũng là cách `scripts/refactor-diff.mjs` chạy hai cây mà không rò state sang nhau.
 *
 * stdout chỉ chứa JSON; mọi thông báo khác đi stderr để `JSON.parse` ở phía gọi không bao giờ vỡ.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runWebappScenario, traceJson } from "../__tests__/helpers/webapp-scenario.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { entry: path.join(ROOT, "webapp-app.mjs"), overrides: {}, out: null, capTimers: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--entry") args.entry = path.resolve(ROOT, argv[i += 1]);
    else if (flag === "--overrides") args.overrides = JSON.parse(argv[i += 1]);
    else if (flag === "--out") args.out = path.resolve(ROOT, argv[i += 1]);
    else if (flag === "--cap-timers") args.capTimers = Number(argv[i += 1]);
    else throw new Error(`tham số lạ: ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// `txVisibleOnChain` chờ THẬT 4 × 3s trước khi kết luận "không thấy". Test nhánh cảnh báo (R4) cần
// đi hết đường đó mà không tốn 12 giây, nên cho phép hạ trần `setTimeout` — chỉ trong tiến trình này
// và chỉ khi phía gọi yêu cầu rõ.
if (args.capTimers !== null) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, Math.min(ms ?? 0, args.capTimers), ...rest);
}

const trace = await runWebappScenario({ entry: args.entry, ...args.overrides });
const json = traceJson(trace);

if (args.out) {
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, json);
  console.error(`[webapp-trace] đã ghi ${path.relative(ROOT, args.out)} (${trace.steps.length} bước)`);
} else {
  process.stdout.write(json);
}
