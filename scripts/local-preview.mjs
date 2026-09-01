import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previewRoot = join(projectRoot, ".local-preview");
const ignoredEntries = new Set([
  ".git",
  ".local-preview",
  ".env.local",
  ".vscode",
  "node_modules",
]);

const readLocalEnvironment = () => {
  const environmentPath = join(projectRoot, ".env.local");
  if (!existsSync(environmentPath)) return {};

  return Object.fromEntries(
    readFileSync(environmentPath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        return [
          line.slice(0, separatorIndex).trim(),
          line.slice(separatorIndex + 1).trim(),
        ];
      })
  );
};

const addLocalMdxTabs = (content) =>
  content.replace(
    /(\n([ \t]*)<Tab title="Sandbox">[\s\S]*?\n\2<\/Tab>)/g,
    (sandboxTab) =>
      `${sandboxTab}${sandboxTab
        .replace('<Tab title="Sandbox">', '<Tab title="Local">')
        .replaceAll("https://dev-api.skortorent.com", "http://localhost:3200")}`
  );

const addLocalOpenApiServer = (content) =>
  content.replace(
    /(\n  - url: https:\/\/dev-api\.skortorent\.com[^\n]*\n    description: Sandbox)/g,
    (sandboxServer) =>
      `${sandboxServer}${sandboxServer
        .replace("https://dev-api.skortorent.com", "http://localhost:3200")
        .replace("description: Sandbox", "description: Local")}`
  );

const transformFile = (sourcePath, destinationPath) => {
  mkdirSync(dirname(destinationPath), { recursive: true });

  if (sourcePath === join(projectRoot, "docs.json")) {
    const config = JSON.parse(readFileSync(sourcePath, "utf8"));
    config.api = config.api ?? {};
    config.api.playground = config.api.playground ?? {};
    config.api.playground.proxy = false;
    writeFileSync(destinationPath, `${JSON.stringify(config, null, 2)}\n`);
    return;
  }

  if (sourcePath.endsWith(".mdx")) {
    writeFileSync(
      destinationPath,
      addLocalMdxTabs(readFileSync(sourcePath, "utf8"))
    );
    return;
  }

  if (sourcePath.endsWith(`${sep}openapi.yaml`)) {
    writeFileSync(
      destinationPath,
      addLocalOpenApiServer(readFileSync(sourcePath, "utf8"))
    );
    return;
  }

  copyFileSync(sourcePath, destinationPath);
};

const shouldIgnore = (relativePath) => {
  const [topLevelEntry] = relativePath.split(sep);
  return ignoredEntries.has(topLevelEntry);
};

const copyTree = (sourceDirectory, destinationDirectory) => {
  mkdirSync(destinationDirectory, { recursive: true });

  for (const entry of readdirSync(sourceDirectory)) {
    const sourcePath = join(sourceDirectory, entry);
    const relativePath = relative(projectRoot, sourcePath);
    if (shouldIgnore(relativePath)) continue;

    const destinationPath = join(destinationDirectory, entry);
    if (statSync(sourcePath).isDirectory()) {
      copyTree(sourcePath, destinationPath);
    } else {
      transformFile(sourcePath, destinationPath);
    }
  }
};

const preparePreview = () => {
  rmSync(previewRoot, { recursive: true, force: true });
  copyTree(projectRoot, previewRoot);
};

const environment = readLocalEnvironment();
if (environment.SKOR_DOCS_ENV !== "local") {
  console.error("SKOR_DOCS_ENV must be set to local in .env.local");
  process.exit(1);
}

preparePreview();

if (process.argv.includes("--prepare-only")) {
  process.exit(0);
}

let refreshTimer;
const watcher = watch(projectRoot, { recursive: true }, (_event, filename) => {
  if (!filename || shouldIgnore(filename)) return;

  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const sourcePath = join(projectRoot, filename);
    const destinationPath = join(previewRoot, filename);

    if (!existsSync(sourcePath)) {
      rmSync(destinationPath, { recursive: true, force: true });
      return;
    }

    if (statSync(sourcePath).isFile()) {
      transformFile(sourcePath, destinationPath);
    }
  }, 100);
});

const mintArgs = process.argv.slice(2).filter((arg) => arg !== "--prepare-only");
const preview = spawn("mint", ["dev", ...mintArgs], {
  cwd: previewRoot,
  stdio: "inherit",
});

const stop = (signal) => {
  watcher.close();
  preview.kill(signal);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
preview.on("exit", (code) => {
  watcher.close();
  process.exit(code ?? 0);
});
