import { type } from "os";
import * as vscode from "vscode";
import { CodeActionKind, commands, TextEdit, workspace } from "vscode";
import { ClangTidyReplacement } from "./clang-tidy-yaml";

import { lintTextDocument, lintActiveTextDocument } from "./lint";

import { killClangTidy, findOpenedTextDocument } from "./tidy";

export function activate(context: vscode.ExtensionContext) {
    let subscriptions = context.subscriptions;

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            "cpp",
            new ClangTidyInfo(),
            {
                providedCodeActionKinds: ClangTidyInfo.providedCodeActionKinds,
            }
        )
    );

    let diagnosticCollection = vscode.languages.createDiagnosticCollection();
    subscriptions.push(diagnosticCollection);

    let loggingChannel = vscode.window.createOutputChannel("Clang-Tidy");
    subscriptions.push(loggingChannel);

    async function lintAndSetDiagnostics(
        file: vscode.TextDocument,
        fixErrors = false
    ) {
        const diagnostics = await lintTextDocument(
            file,
            loggingChannel,
            fixErrors
        );
        if (diagnostics.length === 0)
            diagnosticCollection.delete(file.uri);
        else
            diagnosticCollection.set(file.uri, diagnostics);
    }

    async function lintActiveDocAndSetDiagnostics() {
        const diag = await lintActiveTextDocument(loggingChannel);
        if (diag.document) {
            if (diag.diagnostics.length === 0)
                diagnosticCollection.delete(diag.document.uri);
            else
                diagnosticCollection.set(diag.document.uri, diag.diagnostics);
        }
    }

    subscriptions.push(
        workspace.onDidSaveTextDocument((doc) => {
            if (workspace.getConfiguration("clang-tidy").get("lintOnSave")) {
                if (
                    doc.uri.scheme === "file" &&
                    doc.uri.fsPath.endsWith(".clang-tidy")
                ) {
                    diagnosticCollection.clear();
                    lintActiveDocAndSetDiagnostics();
                } else {
                    const fixErrors = workspace
                        .getConfiguration("clang-tidy")
                        .get("fixOnSave") as boolean;
                    lintAndSetDiagnostics(doc, fixErrors);
                }
            }
        })
    );
    subscriptions.push(
        workspace.onDidCloseTextDocument((doc) =>
            diagnosticCollection.delete(doc.uri)
        )
    );

    subscriptions.push(workspace.onWillSaveTextDocument(killClangTidy));

    subscriptions.push(
        workspace.onDidChangeConfiguration((config) => {
            if (config.affectsConfiguration("clang-tidy")) {
                diagnosticCollection.clear();
                lintActiveDocAndSetDiagnostics();
            }
        })
    );

    subscriptions.push(
        commands.registerCommand(
            "clang-tidy.lintFile",
            lintActiveDocAndSetDiagnostics
        )
    );

    subscriptions.push(
        workspace.onDidChangeTextDocument((doc) => {
            const diagnostics = diagnosticCollection.get(doc.document.uri);
            if (!diagnostics) {
                return;
            }

            let newDiagnostics: vscode.Diagnostic[] = [];
            diagnostics.forEach((diagnostic) => {
                const hasOverlap = doc.contentChanges.some((change) => {
                    return change.range.intersection(diagnostic.range) !== undefined || (change.range.isSingleLine && change.range.start.line === diagnostic.range.start.line);
                });
                if (!hasOverlap) {
                    newDiagnostics.push(diagnostic);
                }
            });

            if (newDiagnostics.length === 0)
                diagnosticCollection.delete(doc.document.uri);
            else if (newDiagnostics.length !== diagnostics.length)
                diagnosticCollection.set(doc.document.uri, newDiagnostics);
        })
    );

    subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && !diagnosticCollection.has(editor.document.uri)) {
                lintActiveDocAndSetDiagnostics();
            }
        })
    );

    subscriptions.push(
        commands.registerCommand(
            "clang-tidy.landFixes",
            (document?: vscode.TextDocument, range?: vscode.Range) => {
                if (!document) return;

                vscode.commands.executeCommand("workbench.action.files.saveFiles", document.uri);

                if (vscode.window.activeTextEditor && document !== vscode.window.activeTextEditor.document) {
                    const activeDoc = vscode.window.activeTextEditor.document;
                    const diagnostics = diagnosticCollection.get(activeDoc.uri);
                    if (!diagnostics)
                        return;

                    if (range) {
                        let newDiagnostics: vscode.Diagnostic[] = [];
                        diagnostics.forEach((diagnostic) => {
                            const hasOverlap = range.intersection(diagnostic.range) !== undefined || (range.isSingleLine && range.start.line === diagnostic.range.start.line);
                            if (!hasOverlap) {
                                newDiagnostics.push(diagnostic);
                            }
                        });
                        if (newDiagnostics.length === 0)
                            diagnosticCollection.delete(activeDoc.uri);
                        else if (newDiagnostics.length !== diagnostics.length)
                            diagnosticCollection.set(activeDoc.uri, newDiagnostics);
                    }

                    setTimeout(() => {
                        lintActiveDocAndSetDiagnostics();
                    }, 250);
                }
            }
        )
    );

    lintActiveDocAndSetDiagnostics();
}

/**
 * Provides code actions corresponding to diagnostic problems.
 */
export class ClangTidyInfo implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.QuickFix,
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.CodeAction[] {
        // for each diagnostic entry that has the matching `code`, create a code action command
        return context.diagnostics.reduce((acc, diagnostic) => {
            const action = this.createCommandCodeAction(document, diagnostic);
            if (!!action) {
                acc.push(action);
            }
            return acc;
        }, [] as vscode.CodeAction[]);
    }

    private createCommandCodeAction(
        document: vscode.TextDocument,
        diagnostic: vscode.Diagnostic
    ): vscode.CodeAction | null {
        if (
            diagnostic.source !== "clang-tidy" ||
            !diagnostic.relatedInformation ||
            diagnostic.relatedInformation.length !== 1
        ) {
            return null;
        }

        const loc = diagnostic.relatedInformation[0].location;
        const text = diagnostic.relatedInformation[0].message;

        const changes = new vscode.WorkspaceEdit();
        changes.replace(
            loc.uri,
            loc.range,
            text
        );

        let doc = findOpenedTextDocument(loc.uri.fsPath);
        if (doc === undefined) doc = document;
        return {
            title: `[Clang-Tidy] Change to ${text}`,
            diagnostics: [diagnostic],
            kind: CodeActionKind.QuickFix,
            edit: changes,
            command: {
                title: "Save File and reanalize",
                command: "clang-tidy.landFixes",
                arguments: [doc, diagnostic.range],
            },
        };
    }
}

export function deactivate() { }
