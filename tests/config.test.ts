import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, userConfigPath } from "../src/config.ts";

test("the platform user file, nearest contest and relative override merge field by field", async () => {
  const root = await mkdtemp(join(tmpdir(), "xprint-layers-"));
  try {
    const env = {
      HOME: join(root, "home"),
      LOCALAPPDATA: join(root, "LocalAppData"),
      XDG_CONFIG_HOME: join(root, "xdg"),
      XPRINT_CONFIG: "override.yaml",
    };
    const user = userConfigPath(env);
    const contest = join(root, "contest");
    const problem = join(contest, "A");
    await mkdir(dirname(user), { recursive: true });
    await mkdir(problem, { recursive: true });
    await writeFile(user, "printer: VP\nteam: 校队\ncolor: monochrome\n");
    await writeFile(join(root, ".xprint.yaml"), "team: ignored outer contest\n");
    await writeFile(join(contest, ".xprint.yaml"), 'location: "007"\ncolor: color\n');
    await writeFile(join(problem, "override.yaml"), "printer: Another VP\n");
    expect(await loadConfig(problem, env)).toEqual({
      printer: "Another VP", team: "校队", location: "007", color: "color",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
