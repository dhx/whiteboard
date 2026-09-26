// Starts the Open Collaboration Tools server on port 8100. Two upstream
// problems in open-collaboration-server 0.3.1 shape this file:
// - its `oct-server` bin imports a bundle the npm release does not ship, so
//   this loads the compiled entry point next to the package's main module;
// - `--port` is parsed with `parseInt(value, previous)`, which turns any
//   value into NaN, so the port stays at its default of 8100.
if (!process.env.OCT_JWT_PRIVATE_KEY)
  throw new Error(
    "Set OCT_JWT_PRIVATE_KEY to a long random secret. Without it the server signs login tokens with a key published in its source.",
  );

process.argv.push("--hostname", process.env.OCT_HOST ?? "127.0.0.1");

await import(new URL("app.js", import.meta.resolve("open-collaboration-server")).href);
