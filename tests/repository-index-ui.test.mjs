import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [navigation, missionsPage, repositoriesPage, repositoryPage, styles] = await Promise.all([
  readFile(new URL("../app/app-navigation.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/missions/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/repositories/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/repositories/[repositoryId]/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
]);

test("primary application navigation exposes the repository overview", () => {
  assert.match(navigation, /href="\/repositories"[\s\S]*Repositories/);
});

test("mission filters use one collapsible compact row without changing search", () => {
  assert.match(missionsPage, /Safe mission search[\s\S]*name="q"/);
  assert.match(missionsPage, /<details className="mission-filter-disclosure"/);
  assert.match(missionsPage, /className="mission-filter-row"/);
  for (const filter of ['name="status"', 'name="origin"', 'name="unknownCost"'])
    assert.match(missionsPage, new RegExp(filter));
  assert.match(styles, /\.mission-filter-row[\s\S]*grid-template-columns: repeat\(3,/);
});

test("repository overview is workspace scoped and explains confidence without inventing evidence", () => {
  assert.match(repositoriesPage, /requirePageIdentity\("\/repositories"\)/);
  assert.match(repositoriesPage, /WHERE r\.workspace_id=\$1 AND r\.disabled_at IS NULL/);
  assert.match(repositoriesPage, /repository-score-explanation/);
  assert.match(repositoriesPage, /Why this score/);
  assert.match(repositoriesPage, /Unknown dimensions lower confidence/);
  assert.match(repositoriesPage, /mission-agent repository add \/absolute\/path\/to\/repository/);
  assert.match(repositoriesPage, /href={`\/repositories\/\$\{repository\.repository_id\}`}/);
  assert.match(repositoryPage, /id="health-evidence"/);
});
