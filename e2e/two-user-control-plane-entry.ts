import { errAsync, okAsync } from "neverthrow";
import { GitResourceSource } from "../apps/control-plane/src/adapters/git-resources/git.ts";
import { main } from "../apps/control-plane/src/main.ts";
import { localOwnedGitCredentials } from "./testkit/owned-resource-source.ts";

const identities = {
  alice: {
    id: "00000000-0000-4000-8000-00000000000a",
    issuer: "pi-orb:e2e",
    subject: "alice",
    email: "alice@example.test",
  },
  bob: {
    id: "00000000-0000-4000-8000-00000000000b",
    issuer: "pi-orb:e2e",
    subject: "bob",
    email: "bob@example.test",
  },
} as const;

const mockFor = (prefix: "ALICE" | "BOB") => ({
  oauthBaseUrl: process.env[`PI_ORB_E2E_${prefix}_OAUTH_URL`] ?? "",
  inferenceBaseUrl: process.env[`PI_ORB_E2E_${prefix}_INFERENCE_URL`] ?? "",
});

const repository = process.env["PI_ORB_E2E_RESOURCE_REPOSITORY"];

void main({
  ...(repository === undefined
    ? {}
    : {
        resourceSourceFactory: (
          credentials: import("../apps/control-plane/src/adapters/git-resources/git.ts").GitCredentials,
        ) =>
          new GitResourceSource(
            localOwnedGitCredentials(credentials, repository, (orbId, environment) => {
              const count = Number(environment.GIT_CONFIG_COUNT ?? "0");
              const header = Array.from({ length: count }, (_, index) => index).find((index) =>
                environment[`GIT_CONFIG_KEY_${index}`]?.endsWith(".extraHeader"),
              );
              const authorization =
                header === undefined ? undefined : environment[`GIT_CONFIG_VALUE_${header}`];
              const owner =
                authorization === undefined
                  ? "public"
                  : ((["alice", "bob"] as const).find(
                      (candidate) =>
                        authorization ===
                        `Authorization: Basic ${Buffer.from(`x-access-token:github-access-${candidate}`).toString("base64")}`,
                    ) ?? "unknown");
              console.log(`multi-user-resource-owner orb=${orbId} owner=${owner}`);
            }),
          ),
      }),
  mockOpenAiForUser: (userId) => mockFor(userId === identities.alice.id ? "ALICE" : "BOB"),
  requestPrincipalResolverFactory: (task, users) => (request) => {
    const selected = request.headers["x-pi-orb-e2e-principal"];
    if (selected === "ops") return okAsync({ kind: "ops" as const, id: "e2e-ops" });
    const identity =
      selected === "alice" ? identities.alice : selected === "bob" ? identities.bob : null;
    if (identity === null) {
      return errAsync({ type: "unauthenticated" as const, message: "missing E2E principal" });
    }
    return users
      .resolveUser(
        task,
        { issuer: identity.issuer, subject: identity.subject, email: identity.email },
        { id: identity.id, now: task.wallNow() },
      )
      .map((user) => ({ kind: "user" as const, user }));
  },
});
