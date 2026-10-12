import { pathToFileURL } from "node:url";
import { run } from "./publish-post/run.mjs";

// Queues or schedules a post through the Worker as a service identity.
// Usage, the job format and the output are documented in the README
// ("Command-line client for services"). This file is the entry point only;
// the client itself is in `publish-post/`, one module per step.

const isEntryPoint =
  import.meta.main ??
  (process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href);
if (isEntryPoint) {
  const { exitCode, document } = await run(process.argv.slice(2));
  // Stdout carries only the JSON result, so callers can parse it as is.
  process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  process.exitCode = exitCode;
}
