import { afterEach, expect, it } from "vitest";
import { openThrowawayPostgres } from "./postgres.ts";
import type { StoreContractSubject } from "./store-contract.ts";

const url = process.env["PI_ORB_TEST_DATABASE_URL"];
const subjects: StoreContractSubject[] = [];
afterEach(async () => {
  await Promise.all(subjects.splice(0).map((subject) => subject.database.close()));
});

it.skipIf(!url)("keeps two active PostgreSQL subjects and their migrations isolated", async () => {
  if (!url) return;
  const first = await openThrowawayPostgres(url);
  subjects.push(first);
  (await first.client.query("CREATE TABLE isolation_marker (value text)"))._unsafeUnwrap();
  (await first.client.query("INSERT INTO isolation_marker VALUES ('first')"))._unsafeUnwrap();
  const second = await openThrowawayPostgres(url);
  subjects.push(second);
  (await second.client.query("CREATE TABLE isolation_marker (value text)"))._unsafeUnwrap();
  (await second.client.query("INSERT INTO isolation_marker VALUES ('second')"))._unsafeUnwrap();
  const migrations = await Promise.all(subjects.map((subject) => subject.database.migrate()));
  for (const result of migrations) result._unsafeUnwrap();
  for (const [index, subject] of subjects.entries()) {
    expect(
      (await subject.client.query("SELECT value FROM isolation_marker"))._unsafeUnwrap().rows,
    ).toEqual([{ value: index === 0 ? "first" : "second" }]);
  }
  (await second.database.close())._unsafeUnwrap();
  subjects.pop();
  expect(
    (await first.client.query("SELECT value FROM isolation_marker"))._unsafeUnwrap().rows,
  ).toEqual([{ value: "first" }]);
});
