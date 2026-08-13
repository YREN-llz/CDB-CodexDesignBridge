import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const CANCELLED = "__CDB_DIRECTORY_PICKER_CANCELLED__";
const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

export async function chooseLocalProjectLocation({
  initialDir = "",
  purpose = "design",
  platform = process.platform,
  environment = process.env,
  execute = executePicker,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const normalizedInitialDir = await existingDirectory(initialDir);
  const command = createDirectoryPickerCommand({
    platform,
    initialDir: normalizedInitialDir,
    purpose,
    environment,
  });
  const result = await execute(command, { timeoutMs });
  const parsed = parseDirectoryPickerResult(result);
  if (parsed.cancelled) {
    return {
      selected: false,
      cancelled: true,
      path: "",
      platform,
    };
  }

  const selectedPath = path.resolve(parsed.path);
  const selectedStat = await stat(selectedPath).catch(() => null);
  if (!selectedStat?.isDirectory()) {
    throw new Error("选择的位置不是可用的本地文件夹。");
  }
  return {
    selected: true,
    cancelled: false,
    path: selectedPath,
    platform,
  };
}

export function createDirectoryPickerCommand({
  platform = process.platform,
  initialDir = "",
  purpose = "design",
  environment = process.env,
} = {}) {
  const title = purpose === "figma"
    ? "选择 Figma 项目的保存位置"
    : purpose === "open"
      ? "选择要打开的 CDB 项目文件夹"
      : "选择 CDB 项目的保存位置";
  const env = {
    ...environment,
    CDB_DIRECTORY_PICKER_INITIAL: String(initialDir || ""),
    CDB_DIRECTORY_PICKER_TITLE: title,
    CDB_DIRECTORY_PICKER_CANCELLED: CANCELLED,
  };

  if (platform === "win32") {
    const windowsRoot =
      environment.SystemRoot || environment.WINDIR || "C:\\Windows";
    return {
      command: path.join(
        windowsRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        windowsPickerScript(),
      ],
      options: { env, windowsHide: true },
      cancelExitCodes: [],
    };
  }

  if (platform === "darwin") {
    return {
      command: "/usr/bin/osascript",
      args: ["-e", macPickerScript()],
      options: { env },
      cancelExitCodes: [],
    };
  }

  if (platform === "linux") {
    const initial = initialDir
      ? `${initialDir.replace(/[\\/]+$/, "")}/`
      : "";
    return {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        `--title=${title}`,
        ...(initial ? [`--filename=${initial}`] : []),
      ],
      options: { env },
      cancelExitCodes: [1],
    };
  }

  throw new Error("当前系统暂不支持 CDB 本地文件夹选择器。");
}

export function parseDirectoryPickerResult({
  code = 0,
  stdout = "",
  stderr = "",
  cancelExitCodes = [],
} = {}) {
  const output = String(stdout || "").trim();
  if (output === CANCELLED || cancelExitCodes.includes(code)) {
    return { cancelled: true, path: "" };
  }
  if (code !== 0) {
    const detail = String(stderr || "").trim().replace(/\s+/g, " ").slice(-240);
    throw new Error(
      detail
        ? `无法打开本地文件夹选择器：${detail}`
        : "无法打开本地文件夹选择器。",
    );
  }
  if (!output || output.includes("\0")) {
    throw new Error("本地文件夹选择器没有返回有效路径。");
  }
  return { cancelled: false, path: output };
}

async function existingDirectory(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const candidate = path.resolve(value.trim());
  const candidateStat = await stat(candidate).catch(() => null);
  return candidateStat?.isDirectory() ? candidate : "";
}

function executePicker(specification, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      specification.command,
      specification.args,
      specification.options,
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const append = (current, chunk) => {
      const next = current + String(chunk);
      return next.length > MAX_OUTPUT_BYTES
        ? next.slice(-MAX_OUTPUT_BYTES)
        : next;
    };
    child.stdout?.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) =>
      finish(() => reject(new Error(
        error?.code === "ENOENT"
          ? "当前系统没有可用的本地文件夹选择器。"
          : `无法打开本地文件夹选择器：${error.message}`,
      ))),
    );
    child.once("exit", (code) =>
      finish(() => resolve({
        code: Number.isInteger(code) ? code : 1,
        stdout,
        stderr,
        cancelExitCodes: specification.cancelExitCodes || [],
      })),
    );
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error("本地文件夹选择已超时，请重新选择。")));
    }, Math.max(1_000, timeoutMs));
  });
}

function windowsPickerScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = [Environment]::GetEnvironmentVariable('CDB_DIRECTORY_PICKER_TITLE')",
    "$dialog.ShowNewFolderButton = $true",
    "$initial = [Environment]::GetEnvironmentVariable('CDB_DIRECTORY_PICKER_INITIAL')",
    "if ($initial -and [IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }",
    "$result = $dialog.ShowDialog()",
    "if ($result -eq [Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {",
    "  [Console]::Out.Write($dialog.SelectedPath)",
    "} else {",
    "  [Console]::Out.Write([Environment]::GetEnvironmentVariable('CDB_DIRECTORY_PICKER_CANCELLED'))",
    "}",
    "$dialog.Dispose()",
  ].join("; ");
}

function macPickerScript() {
  return [
    "set pickerTitle to system attribute \"CDB_DIRECTORY_PICKER_TITLE\"",
    "set initialPath to system attribute \"CDB_DIRECTORY_PICKER_INITIAL\"",
    "set cancelledToken to system attribute \"CDB_DIRECTORY_PICKER_CANCELLED\"",
    "try",
    "  if initialPath is \"\" then",
    "    set selectedFolder to choose folder with prompt pickerTitle",
    "  else",
    "    set selectedFolder to choose folder with prompt pickerTitle default location POSIX file initialPath",
    "  end if",
    "  return POSIX path of selectedFolder",
    "on error number -128",
    "  return cancelledToken",
    "end try",
  ].join("\n");
}
