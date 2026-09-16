const FRAMES = ["001", "011", "010", "110", "111", "101", "100", "000"];

/** Fixed Gray-code choreography, not a counter or an inference-progress signal. */
export function BitRegister() {
  return (
    <span className="bit-register" role="status" aria-label="Agent working">
      <span className="bit-register-frames" aria-hidden="true">
        {FRAMES.map((frame) => (
          <span key={frame}>{frame}</span>
        ))}
      </span>
    </span>
  );
}
