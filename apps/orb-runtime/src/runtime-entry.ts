const mode = process.env.PI_ORB_RUNTIME_MODE ?? "execution";
if (mode === "execution") await import("./execution/main.ts");
else if (mode === "claude") await import("./main.ts");
else {
  console.error("invalid PI_ORB_RUNTIME_MODE; expected claude or execution");
  process.exitCode = 1;
}

export {};
