var vscode = require('vscode')

/**
 * Escapes characters that have a special meaning in regular expressions.
 * @param {string} string The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const GREMLINS = 'gremlins'

const GREMLINS_LEVELS = {
  NONE: 'none',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
}

const GREMLINS_SEVERITIES = {
  [GREMLINS_LEVELS.INFO]: vscode.DiagnosticSeverity.Information,
  [GREMLINS_LEVELS.WARNING]: vscode.DiagnosticSeverity.Warning,
  [GREMLINS_LEVELS.ERROR]: vscode.DiagnosticSeverity.Error,
}

const gremlinsDefaultColor = 'rgba(169, 68, 66, .75)'

const eventListeners = []

let decorationTypes = {}

let processedDocuments = {}

const icons = {
  light: null,
  dark: null,
}

let diagnosticCollection = null

function configureDiagnosticsCollection(showDiagnostics) {
  if (showDiagnostics && !diagnosticCollection) {
    diagnosticCollection = diagnosticCollection =
      vscode.languages.createDiagnosticCollection(GREMLINS)
  } else if (!showDiagnostics && diagnosticCollection) {
    diagnosticCollection.clear()
    diagnosticCollection.dispose()
    diagnosticCollection = null
  }
  return diagnosticCollection
}

function disposeDecorationTypes() {
  Object.values(decorationTypes).forEach((decorationType) => {
    decorationType.dispose()
  })
  decorationTypes = {}
}

/**
 *
 * @param {vscode.ExtensionContext} context
 */
function loadIcons(context) {
  icons.light = context.asAbsolutePath('images/gremlins-light.svg')
  icons.dark = context.asAbsolutePath('images/gremlins-dark.svg')
}

/**
 *
 * @param {vscode.TextDocument} document
 */
function loadConfiguration(document) {
  const gremlinsConfiguration = vscode.workspace.getConfiguration(
    GREMLINS,
    document,
  )

  const gremlins = gremlinsFromConfig(gremlinsConfiguration)

  const showDiagnostics = gremlinsConfiguration.showInProblemPane
  const diagnosticCollection = configureDiagnosticsCollection(showDiagnostics)

  let gremlinPatterns = Object.keys(gremlins).map(
    (char) => `${escapeRegExp(char)}+`,
  )

  let regexpWithAllChars = new RegExp(gremlinPatterns.join('|'), 'g')

  return {
    gremlins,
    regexpWithAllChars,
    diagnosticCollection,
  }
}

function gremlinsFromConfig(gremlinsConfiguration) {
  const gremlinsLevels = {
    [GREMLINS_LEVELS.INFO]: gremlinsConfiguration.color_info,
    [GREMLINS_LEVELS.WARNING]: gremlinsConfiguration.color_warning,
    [GREMLINS_LEVELS.ERROR]: gremlinsConfiguration.color_error,
  }
  const gremlinsCharacters = gremlinsConfiguration.characters
  const gutterIconSize = gremlinsConfiguration.gutterIconSize
  const hexCodePointsRangeRegex = /^([0-9a-f]+)(?:-([0-9a-f]+))?$/i

  const lightIcon = {
    gutterIconPath: icons.light,
    gutterIconSize: gutterIconSize,
  }
  const darkIcon = {
    gutterIconPath: icons.dark,
    gutterIconSize: gutterIconSize,
  }

  const gremlins = {}
  for (const [hexCodePoint, config] of Object.entries(gremlinsCharacters)) {
    const severityLevel = config.level
      ? config.level.toLowerCase()
      : GREMLINS_LEVELS.ERROR
    if (severityLevel === GREMLINS_LEVELS.NONE) {
      // Ignore gremlins marked as "none"
      continue
    }

    let decorationType = {
      light: config.hideGutterIcon ? {} : lightIcon,
      dark: config.hideGutterIcon ? {} : darkIcon,
      overviewRulerColor: config.overviewRulerColor || gremlinsDefaultColor,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }

    if (config.zeroWidth) {
      decorationType.borderWidth = '1px'
      decorationType.borderStyle = 'solid'
      decorationType.borderColor = gremlinsLevels[severityLevel]
    } else {
      decorationType.backgroundColor = gremlinsLevels[severityLevel]
    }

    let hexCodePointsRange = hexCodePoint.match(hexCodePointsRangeRegex)
    if (hexCodePointsRange && hexCodePointsRange[2] !== undefined) {
      // This is a range of characters
      // Lets create all characters of the range, with the same configuration
      let firstChar = parseInt(`0x${hexCodePointsRange[1]}`, 16)
      let lastChar = parseInt(`0x${hexCodePointsRange[2]}`, 16)

      for (var index = firstChar; index <= lastChar; ++index) {
        let thisHexCodePoint = index.toString(16)

        gremlins[String.fromCharCode(index)] = Object.assign({}, config, {
          thisHexCodePoint,
          decorationType: cachedDecorationType(decorationType),
        })
      }
    } else {
      // This is a single character
      gremlins[charFromHex(hexCodePoint)] = Object.assign({}, config, {
        hexCodePoint,
        decorationType: cachedDecorationType(decorationType),
      })
    }
  }

  return gremlins
}

function cachedDecorationType(decorationType) {
  const cacheKey = JSON.stringify(decorationType)
  if (!decorationTypes[cacheKey]) {
    decorationTypes[cacheKey] =
      vscode.window.createTextEditorDecorationType(decorationType)
  }
  return decorationTypes[cacheKey]
}

function charFromHex(hexCodePoint) {
  return String.fromCodePoint(`0x${hexCodePoint}`)
}

/**
 *
 * @param {vscode.TextEditor} activeTextEditor
 */
function checkForGremlins(activeTextEditor) {
  if (!activeTextEditor) {
    return
  }

  const doc = activeTextEditor.document

  let { gremlins, regexpWithAllChars, diagnosticCollection } =
    loadConfiguration(doc)

  const decorations = {}
  let diagnostics = []

  for (let lineNum = 0; lineNum < doc.lineCount; lineNum++) {
    let lineText = doc.lineAt(lineNum)
    let line = lineText.text

    let match
    while ((match = regexpWithAllChars.exec(line))) {
      const matchedText = match[0]
      const gremlin = gremlins[matchedText[0]]

      if (!gremlin) continue

      let startPos = new vscode.Position(lineNum, match.index)
      let endPos = new vscode.Position(
        lineNum,
        match.index + matchedText.length,
      )
      const range = new vscode.Range(startPos, endPos)

      const hoverMessage = `${matchedText.length} ${gremlin.description}${
        matchedText.length > 1 ? 's' : ''
      } (unicode U+${gremlin.hexCodePoint.toUpperCase()}) here`

      const decoration = { range, hoverMessage }

      const decorationType = gremlin.decorationType
      if (!decorations[decorationType.key]) {
        decorations[decorationType.key] = {
          decorationType: decorationType,
          options: [],
        }
      }
      decorations[decorationType.key].options.push(decoration)

      if (diagnosticCollection) {
        const severity = GREMLINS_SEVERITIES[gremlin.level]
        const diagnostic = {
          range: decoration.range,
          message: decoration.hoverMessage,
          severity: severity,
          source: 'Gremlins tracker',
        }
        diagnostics.push(diagnostic)
      }
    }
  }

  drawDecorations(activeTextEditor, decorations)

  if (diagnosticCollection) {
    diagnosticCollection.set(activeTextEditor.document.uri, diagnostics)
  }

  processedDocuments[activeTextEditor.document.uri] = { decorations }
}

function drawDecorations(activeTextEditor, decorations) {
  for (const { decorationType, options } of Object.values(decorations)) {
    activeTextEditor.setDecorations(decorationType, options)
  }
}

function cleanGremlinsInEditor(editor) {
  if (!editor) {
    vscode.window.showInformationMessage(
      'No active editor to clean gremlins from.',
    )
    return
  }
  const document = editor.document
  const { gremlins, regexpWithAllChars } = loadConfiguration(document)
  const fullText = document.getText()

  const cleanedText = fullText.replace(regexpWithAllChars, (matchedChar) => {
    const gremlin = gremlins[matchedChar[0]]
    return gremlin?.replaceWith ?? ''
  })

  if (fullText === cleanedText) {
    vscode.window.showInformationMessage('No gremlins found to clean.')
    return
  }

  const edit = new vscode.WorkspaceEdit()
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(fullText.length),
  )
  edit.replace(document.uri, fullRange, cleanedText)
  vscode.workspace.applyEdit(edit)
}

/**
 *
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  loadIcons(context)

  context.subscriptions.push(
    vscode.commands.registerCommand('gremlins.fixAll', () => {
      cleanGremlinsInEditor(vscode.window.activeTextEditor)
    }),
  )

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', language: '*' },
      new GremlinsActionProvider(),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      },
    ),
  )

  eventListeners.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(GREMLINS)) {
        disposeDecorationTypes()
        processedDocuments = {}

        vscode.window.visibleTextEditors.forEach((editor) =>
          checkForGremlins(editor),
        )
      }
    }),
  )

  eventListeners.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        const processedDocument = processedDocuments[editor.document.uri]
        if (!processedDocument) {
          checkForGremlins(editor)
        } else {
          drawDecorations(editor, processedDocument.decorations)
        }
      }
    }),
  )

  eventListeners.push(
    vscode.workspace.onDidChangeTextDocument((_event) =>
      checkForGremlins(vscode.window.activeTextEditor),
    ),
  )

  eventListeners.push(
    vscode.workspace.onDidCloseTextDocument((textDocument) => {
      diagnosticCollection && diagnosticCollection.delete(textDocument.uri)
      delete processedDocuments[textDocument.uri]
    }),
  )

  checkForGremlins(vscode.window.activeTextEditor)
}
exports.activate = activate

// this method is called when your extension is deactivated
function deactivate() {
  if (diagnosticCollection) {
    diagnosticCollection.clear()
    diagnosticCollection.dispose()
  }

  disposeDecorationTypes()

  eventListeners.forEach((listener) => listener.dispose())
  eventListeners.length = 0
}
exports.deactivate = deactivate

class GremlinsActionProvider {
  provideCodeActions(document, range, context, token) {
    const actions = []
    const gremlinDiagnostics = context.diagnostics.filter(
      (diag) => diag.source === 'Gremlins tracker',
    )

    if (gremlinDiagnostics.length === 0) {
      return
    }

    const { gremlins } = loadConfiguration(document)

    gremlinDiagnostics.forEach((diag) => {
      const gremlinText = document.getText(diag.range)
      const gremlinConfig = gremlins[gremlinText.charAt(0)]

      if (gremlinConfig) {
        const replacement = gremlinConfig.replaceWith ?? ''
        const fullReplacementText = replacement.repeat(gremlinText.length)
        const title = `Fix this: Replace '${gremlinText}' with '${fullReplacementText}'`

        const individualFixAction = new vscode.CodeAction(
          title,
          vscode.CodeActionKind.QuickFix,
        )
        individualFixAction.edit = new vscode.WorkspaceEdit()
        individualFixAction.edit.replace(
          document.uri,
          diag.range,
          fullReplacementText,
        )

        if (actions.length === 0) {
          individualFixAction.isPreferred = true
        }
        actions.push(individualFixAction)
      }
    })

    const fixAllAction = new vscode.CodeAction(
      'Fix all gremlin characters in file',
      vscode.CodeActionKind.QuickFix,
    )
    fixAllAction.command = {
      command: 'gremlins.fixAll',
      title: 'Clean All Gremlins',
    }
    actions.push(fixAllAction)

    return actions
  }
}
