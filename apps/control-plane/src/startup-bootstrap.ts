import { startupPhase } from "./startup.ts";

// --import runs before Node links and evaluates the main module graph.
startupPhase("bootstrap.enter");
