const mode = process.env.PI_ORB_RUNTIME_MODE ?? "pi";
if (mode === "execution") await import("./execution/main.ts");
else if (mode === "pi") await import("./main.ts");
else {
  console.error("invalid PI_ORB_RUNTIME_MODE; expected pi or execution");
  process.exitCode = 1;
}

export {};
