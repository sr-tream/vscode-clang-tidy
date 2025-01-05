import { ChildProcess, execFile, execFileSync } from "child_process";
import * as vscode from "vscode";
import * as jsYaml from "js-yaml";
import {
    ClangTidyDiagnostic,
    ClangTidyResults,
    ClangTidyYaml,
} from "./clang-tidy-yaml";

function clangTidyArgs(files: string[], fixErrors: boolean) {
    let args: string[] = [...files, "--export-fixes=-"];

    const checks = vscode.workspace
        .getConfiguration("clang-tidy")
        .get("checks") as Array<string>;

    if (checks.length > 0) {
        args.push(`--checks=${checks.join(",")}`);
    }

    const compilerArgs = vscode.workspace
        .getConfiguration("clang-tidy")
        .get("compilerArgs") as Array<string>;

    compilerArgs.forEach((arg) => {
        args.push(`--extra-arg=${arg}`);
    });

    const compilerArgsBefore = vscode.workspace
        .getConfiguration("clang-tidy")
        .get("compilerArgsBefore") as Array<string>;

    compilerArgsBefore.forEach((arg) => {
        args.push(`--extra-arg-before=${arg}`);
    });

    const buildPath = vscode.workspace
        .getConfiguration("clang-tidy")
        .get("buildPath") as string;

    if (buildPath.length > 0) {
        args.push(`-p=${buildPath}`);
    }

    if (fixErrors) {
        args.push("--fix");
    }

    return args;
}

function clangTidyExecutable() {
    return vscode.workspace
        .getConfiguration("clang-tidy")
        .get("executable") as string;
}

class ChildProcessWithExitFlag {
    constructor(process: ChildProcess) {
        this.process = process;
        this.exited = false;

        process.on("exit", () => (this.exited = true));
    }

    process: ChildProcess;
    exited: boolean;
}

let clangTidyProcess: ChildProcessWithExitFlag | undefined = undefined;

export function killClangTidy() {
    if (
        clangTidyProcess === undefined ||
        clangTidyProcess.exited ||
        clangTidyProcess.process.killed
    ) {
        return;
    }

    // process.kill() does not work on Windows for some reason.
    // We can use the taskkill command instead.
    if (process.platform === "win32") {
        const pid = clangTidyProcess.process.pid.toString();
        execFileSync("taskkill", ["/pid", pid, "/f", "/t"]);
        clangTidyProcess.process.killed = true;
    } else {
        clangTidyProcess.process.kill();
    }
}

export function runClangTidy(
    files: string[],
    workingDirectory: string,
    loggingChannel: vscode.OutputChannel,
    fixErrors: boolean
): Thenable<string> {
    killClangTidy();

    const progressMessage = fixErrors
        ? "Linting and fixing current file (do not modify it in the meanwhile)..."
        : "Linting current file...";

    const clangTidyResult = new Promise<string>((resolve) => {
        const clangTidy = clangTidyExecutable();
        const args = clangTidyArgs(files, fixErrors);

        loggingChannel.appendLine(`> ${clangTidy} ${args.join(" ")}`);
        loggingChannel.appendLine(
            `Working Directory: ${workingDirectory}`
        );

        clangTidyProcess = new ChildProcessWithExitFlag(
            execFile(
                clangTidy,
                args,
                { cwd: workingDirectory, maxBuffer: 10 * 1024 * 1024 },
                (error, stdout, stderr) => {
                    loggingChannel.appendLine(stdout);
                    loggingChannel.appendLine(stderr);
                    resolve(stdout);
                }
            )
        );
    });

    enum ProgressLocation {
        Notification = "Notification",
        Window = "Window",
        Disabled = "Disabled",
    };
    const progressBarLocation = vscode.workspace
        .getConfiguration("clang-tidy")
        .get("progressBarLocation") as ProgressLocation;

    if (progressBarLocation === ProgressLocation.Disabled) {
        return clangTidyResult;
    }

    const vscodeProgressBarLocation = (() => {
        switch (progressBarLocation) {
            case ProgressLocation.Notification:
                return vscode.ProgressLocation.Notification;
            case ProgressLocation.Window:
                return vscode.ProgressLocation.Window;
            default:
                return vscode.ProgressLocation.Notification;
        }
    })();

    return vscode.window.withProgress(
        { location: vscodeProgressBarLocation },
        (progress) => {
            progress.report({ message: progressMessage });

            return clangTidyResult;
        }
    );
}

function tidyOutputAsObject(clangTidyOutput: string) {
    const yamlIndex = clangTidyOutput.search(/^---$/m);
    if (yamlIndex < 0) {
        return { MainSourceFile: "", Diagnostics: [] };
    }
    const rawYaml = clangTidyOutput.substr(yamlIndex);

    const tidyResults = jsYaml.safeLoad(rawYaml) as ClangTidyYaml;

    let structuredResults: ClangTidyResults = {
        MainSourceFile: tidyResults.MainSourceFile,
        Diagnostics: [],
    };

    tidyResults.Diagnostics.forEach((diag) => {
        if (diag.DiagnosticMessage) {
            structuredResults.Diagnostics.push({
                DiagnosticName: diag.DiagnosticName,
                DiagnosticMessage: {
                    Message: diag.DiagnosticMessage.Message,
                    FilePath: diag.DiagnosticMessage.FilePath,
                    FileOffset: diag.DiagnosticMessage.FileOffset,
                    Replacements: diag.DiagnosticMessage.Replacements,
                    Severity: vscode.DiagnosticSeverity.Warning,
                },
            });
        } else if (diag.Message && diag.FilePath && diag.FileOffset) {
            structuredResults.Diagnostics.push({
                DiagnosticName: diag.DiagnosticName,
                DiagnosticMessage: {
                    Message: diag.Message,
                    FilePath: diag.FilePath,
                    FileOffset: diag.FileOffset,
                    Replacements: diag.Replacements ? diag.Replacements : [],
                    Severity: vscode.DiagnosticSeverity.Warning,
                },
            });
        }
    });

    let diagnostics = structuredResults.Diagnostics;

    const severities = collectDiagnosticSeverities(clangTidyOutput);
    for (let i = 0; i < diagnostics.length || i < severities.length; i++) {
        diagnostics[i].DiagnosticMessage.Severity = severities[i];
    }

    return structuredResults;
}

export function findOpenedTextDocument(filePath: string): vscode.TextDocument | undefined {
    // Check if the file is open (not necessarily visible)
    const openedTextDocument = vscode.workspace.textDocuments.find(document => document.uri.fsPath === filePath);

    // If the document is found among open documents, return it
    if (openedTextDocument) {
        return openedTextDocument;
    }

    // If not found, the document is not opened
    return undefined;
}

function generateVScodeDiagnostics(
    document: vscode.TextDocument,
    tidyDiagnostic: ClangTidyDiagnostic
): vscode.Diagnostic[] {
    const diagnosticMessage = tidyDiagnostic.DiagnosticMessage;
    const fixes = diagnosticMessage.Replacements.filter((replacement) => replacement.FilePath === diagnosticMessage.FilePath || findOpenedTextDocument(replacement.FilePath) !== undefined);
    if (fixes.length > 0) {
        if (fixes[0].Length === 0) {
            const doc = fixes[0].FilePath !== document.fileName ? findOpenedTextDocument(fixes[0].FilePath) as vscode.TextDocument : document;
            const beginPos = doc.positionAt(fixes[0].Offset);
            const endPos = doc.positionAt(
                fixes[fixes.length - 1].Offset + fixes[fixes.length - 1].Length
            );

            let replacementLength = fixes[0].Length;
            let replacementText = fixes[0].ReplacementText;
            if (fixes.length > 1) {
                for (let i = 0; i < fixes.length - 1; i++) {
                    const beginText = doc.positionAt(
                        fixes[i].Offset + fixes[i].Length
                    );
                    const endText = doc.positionAt(
                        fixes[i + 1].Offset
                    );
                    const text = doc.getText(new vscode.Range(beginText, endText));
                    replacementText += text + fixes[i + 1].ReplacementText;
                    replacementLength += text.length + fixes[i + 1].Length;
                }
            }

            let range: vscode.Range;
            if (fixes[0].FilePath !== document.fileName) {
                const line = document.positionAt(diagnosticMessage.FileOffset).line;
                range = new vscode.Range(line, 0, line, Number.MAX_VALUE)
            } else
                range = new vscode.Range(beginPos, endPos);

            let diagnostic = new vscode.Diagnostic(
                range,
                diagnosticMessage.Message,
                diagnosticMessage.Severity
            );
            // embed information needed for quickfix in code
            let info: vscode.DiagnosticRelatedInformation = {
                location: new vscode.Location(
                    vscode.Uri.file(fixes[0].FilePath),
                    new vscode.Range(beginPos, endPos)
                ),
                message: replacementText
            };
            diagnostic.relatedInformation = [info];
            diagnostic.code = tidyDiagnostic.DiagnosticName;
            diagnostic.source = "clang-tidy";
            return [diagnostic];
        } else
            return fixes.map((replacement) => {
                const doc = fixes[0].FilePath !== document.fileName ? findOpenedTextDocument(fixes[0].FilePath) as vscode.TextDocument : document;

                const beginPos = doc.positionAt(replacement.Offset);
                const endPos = doc.positionAt(
                    replacement.Offset + replacement.Length
                );

                let range: vscode.Range;
                if (fixes[0].FilePath !== document.fileName) {
                    const line = document.positionAt(diagnosticMessage.FileOffset).line;
                    range = new vscode.Range(line, 0, line, Number.MAX_VALUE)
                } else
                    range = new vscode.Range(beginPos, endPos);

                let diagnostic = new vscode.Diagnostic(
                    range,
                    diagnosticMessage.Message,
                    diagnosticMessage.Severity
                );
                // embed information needed for quickfix in code
                let info: vscode.DiagnosticRelatedInformation = {
                    location: new vscode.Location(
                        vscode.Uri.file(fixes[0].FilePath),
                        new vscode.Range(beginPos, endPos)
                    ),
                    message: replacement.ReplacementText
                };
                diagnostic.relatedInformation = [info];
                diagnostic.code = tidyDiagnostic.DiagnosticName;
                diagnostic.source = "clang-tidy";
                return diagnostic;
            });
    } else {
        const line = document.positionAt(diagnosticMessage.FileOffset).line;
        let diagnostic = new vscode.Diagnostic(
            new vscode.Range(line, 0, line, Number.MAX_VALUE),
            diagnosticMessage.Message,
            diagnosticMessage.Severity
        );
        diagnostic.code = tidyDiagnostic.DiagnosticName;
        diagnostic.source = "clang-tidy";
        return [diagnostic];
    }
}

function fixDiagnosticRanges(
    tidyResults: ClangTidyResults,
    document: vscode.TextDocument
) {
    const buffer = Buffer.from(document.getText());

    tidyResults.Diagnostics.forEach((diagnostic) => {
        diagnostic.DiagnosticMessage.FileOffset = buffer
            .slice(0, diagnostic.DiagnosticMessage.FileOffset)
            .toString().length;

        diagnostic.DiagnosticMessage.Replacements.forEach((replacement) => {
            replacement.Length = buffer
                .slice(
                    replacement.Offset,
                    replacement.Offset + replacement.Length
                )
                .toString().length;

            replacement.Offset = buffer
                .slice(0, replacement.Offset)
                .toString().length;
        });
    });
}

export function collectDiagnostics(
    clangTidyOutput: string,
    document: vscode.TextDocument
) {
    const tidyResults = tidyOutputAsObject(clangTidyOutput);

    fixDiagnosticRanges(tidyResults, document);

    const results = tidyResults.Diagnostics.reduce((acc, diag) => {
        const diagnosticMessage = diag.DiagnosticMessage;

        // We make these paths relative before comparing them because
        // on Windows, the drive letter is lowercase for the document filename,
        // but uppercase for the diagnostic message file path. This caused the
        // comparison to fail when it shouldn't.
        if (
            vscode.workspace.asRelativePath(document.fileName) !==
            vscode.workspace.asRelativePath(diagnosticMessage.FilePath)
        ) {
            return acc; // The message isn't related to current file
        }
        generateVScodeDiagnostics(document, diag).forEach((a) => acc.push(a));
        return acc;
    }, [] as vscode.Diagnostic[]);

    return results;
}

function collectDiagnosticSeverities(clangTidyOutput: string) {
    const data = clangTidyOutput.split("\n");

    const regex: RegExp = /^.*:\d+:\d+:\s+(warning|error|info|hint):\s+.*$/;

    let severities: vscode.DiagnosticSeverity[] = [];

    data.forEach((line) => {
        const matches = regex.exec(line);
        if (matches === null) {
            return;
        }

        switch (matches[1]) {
            case "error":
                severities.push(vscode.DiagnosticSeverity.Error);
                break;
            case "warning":
                severities.push(vscode.DiagnosticSeverity.Warning);
                break;
            case "info":
                severities.push(vscode.DiagnosticSeverity.Information);
                break;
            case "hint":
                severities.push(vscode.DiagnosticSeverity.Hint);
                break;
            default:
                severities.push(vscode.DiagnosticSeverity.Warning);
                break;
        }
    });

    return severities;
}
