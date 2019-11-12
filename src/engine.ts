import { CodeAction, CodeActionProvider, languages, Uri, workspace } from 'coc.nvim';
import extend from 'deep-extend';
import fs from 'fs';
import jsYaml from 'js-yaml';
import markdownlint, { MarkdownlintResult } from 'markdownlint';
import { applyFix, applyFixes } from 'markdownlint-rule-helpers';
import path from 'path';
import rc from 'rc';
import { CodeActionContext, Diagnostic, DiagnosticSeverity, Position, Range, TextDocument, TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol';

const source = 'markdownlint';
const projectConfigFiles = ['.markdownlint.json', '.markdownlint.yaml', '.markdownlint.yml'];
const configFileParsers = [JSON.parse, jsYaml.safeLoad];

export class MarkdownlintEngine implements CodeActionProvider {
  private outputChannel = workspace.createOutputChannel(source);
  private diagnosticCollection = languages.createDiagnosticCollection(source);
  private config = rc(source, {});

  private outputLine(message: string) {
    if (this.outputChannel) {
      this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
  }

  private async parseLocalConfig() {
    this.outputLine(`Info: global config: ${JSON.stringify(this.config)}`);

    try {
      const preferences = workspace.getConfiguration('coc.preferences');
      const rootFolder = await workspace.resolveRootFolder(Uri.parse(workspace.uri), preferences.get('rootPatterns', []));
      for (const projectConfigFile of projectConfigFiles) {
        const fullPath = path.join(rootFolder, projectConfigFile);
        if (fs.existsSync(fullPath)) {
          // @ts-ignore
          const projectConfig = markdownlint.readConfigSync(fullPath, configFileParsers);
          this.config = extend(this.config, projectConfig);

          this.outputLine(`Info: local config: ${fullPath}, ${JSON.stringify(projectConfig)}`);
          break;
        }
      }
    } catch (_e) {}

    const cocConfig = workspace.getConfiguration('markdownlint').get('config');
    if (cocConfig) {
      this.config = extend(this.config, cocConfig);
      this.outputLine(`Info: config from coc-settings.json: ${JSON.stringify(cocConfig)}`);
    }

    this.outputLine(`Info: full config: ${JSON.stringify(this.config)}`);
  }

  private markdownlintWrapper(document: TextDocument): MarkdownlintResult[] {
    const options: markdownlint.MarkdownlintOptions = {
      resultVersion: 3,
      config: this.config,
      // customRules: customRules,
      strings: {
        [document.uri]: document.getText()
      }
    };

    let results: MarkdownlintResult[] = [];
    try {
      results = markdownlint.sync(options)[document.uri] as MarkdownlintResult[];
    } catch (e) {
      this.outputLine(`Error: lint exception: ${e.stack}`);
    }

    return results;
  }

  constructor() {
    this.parseLocalConfig();
  }

  public async provideCodeActions(document: TextDocument, _range: Range, context: CodeActionContext) {
    const codeActions: CodeAction[] = [];
    for (const diagnostic of context.diagnostics) {
      // @ts-ignore
      if (diagnostic.fixInfo) {
        // @ts-ignore
        const lineNumber = diagnostic.fixInfo.lineNumber - 1 || diagnostic.range.start.line;
        const line = await workspace.getLine(document.uri, lineNumber);
        // @ts-ignore
        const newText = applyFix(line, diagnostic.fixInfo, '\n');

        const edit: WorkspaceEdit = {
          changes: {}
        };

        if (typeof newText === 'string') {
          const range = Range.create(lineNumber, 0, lineNumber, line.length);
          edit.changes![document.uri] = [TextEdit.replace(range, newText)];
        } else {
          edit.changes![document.uri] = [TextEdit.del(diagnostic.range)];
        }

        const title = `Fix: ${diagnostic.message.split(':')[0]}`;
        const action: CodeAction = {
          title,
          edit,
          diagnostics: [...context.diagnostics]
        };

        codeActions.push(action);
      }
    }

    return codeActions;
  }

  public lint(document: TextDocument) {
    this.diagnosticCollection.clear();
    if (document.languageId !== 'markdown') {
      return;
    }

    const results = this.markdownlintWrapper(document);
    if (!results.length) {
      return;
    }

    const diagnostics: Diagnostic[] = [];
    results.forEach((result: MarkdownlintResult) => {
      const ruleDescription = result.ruleDescription;
      // @ts-ignore
      let message = result.ruleNames.join('/') + ': ' + ruleDescription;
      if (result.errorDetail) {
        message += ' [' + result.errorDetail + ']';
      }

      const start = Position.create(result.lineNumber - 1, 0);
      const end = Position.create(result.lineNumber - 1, 0);
      if (result.errorRange) {
        start.character = result.errorRange[0] - 1;
        end.character = start.character + result.errorRange[1];
      }

      const range = Range.create(start, end);
      const diagnostic = Diagnostic.create(range, message);
      diagnostic.severity = DiagnosticSeverity.Warning;
      diagnostic.source = source;
      // @ts-ignore
      diagnostic.fixInfo = result.fixInfo;
      diagnostics.push(diagnostic);
    });

    this.diagnosticCollection.set(document.uri, diagnostics);
  }

  public async fixAll(document: TextDocument) {
    const results = this.markdownlintWrapper(document);
    if (!results.length) {
      return;
    }

    const text = document.getText();
    const fixedText = applyFixes(text, results);
    if (text != fixedText) {
      const edit: WorkspaceEdit = {
        changes: {}
      };

      const doc = workspace.getDocument(document.uri);
      const end = Position.create(doc.lineCount - 1, doc.getline(doc.lineCount - 1).length);
      edit.changes![document.uri] = [TextEdit.replace(Range.create(Position.create(0, 0), end), fixedText)];
      await workspace.applyEdit(edit);
    }
  }
}
