﻿/*!
 *  Copyright 2015 Ron Buckton (rbuckton@chronicles.org)
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
import { Hash, createHash } from "crypto";
import { CancellationToken } from "prex";
import { Dictionary } from "./core";
import { Diagnostics, DiagnosticMessages, Diagnostic, formatList } from "./diagnostics";
import { SyntaxKind, tokenToString } from "./tokens";
import { Symbol, SymbolKind, SymbolTable } from "./symbols";
import { Binder, BindingTable } from "./binder";
import { StringWriter } from "./stringwriter";
import { CompilerOptions } from "./options";
import {
    Node,
    SourceFile,
    UnicodeCharacterLiteral,
    UnicodeCharacterRange,
    Prose,
    Identifier,
    Parameter,
    ParameterList,
    OneOfList,
    Terminal,
    SymbolSet,
    Assertion,
    EmptyAssertion,
    LookaheadAssertion,
    NoSymbolHereAssertion,
    LexicalGoalAssertion,
    ParameterValueAssertion,
    ProseAssertion,
    ProseFragment,
    ProseFragmentLiteral,
    Argument,
    ArgumentList,
    Nonterminal,
    OneOfSymbol,
    LexicalSymbol,
    OptionalSymbol,
    ButNotSymbol,
    SymbolSpan,
    LinkReference,
    RightHandSide,
    RightHandSideList,
    Production,
    SourceElement,
    Define,
    forEachChild
} from "./nodes";
import { NodeNavigator } from "./navigator";


// TODO: Check a Nonterminal as a call
// TODO: Check all Productions to ensure they have the same parameters.

export class Checker {
    private checkedFileSet = new Dictionary<boolean>();
    private bindings: BindingTable;
    private diagnostics: DiagnosticMessages;
    private binder: Binder;
    private innerResolver: Resolver;
    private sourceFile: SourceFile;
    private noStrictParametricProductions: boolean;
    private productionParametersByName: Dictionary<Dictionary<boolean>>;
    private cancellationToken: CancellationToken;

    constructor(bindings: BindingTable, diagnostics: DiagnosticMessages, options?: CompilerOptions, cancellationToken = CancellationToken.none) {
        this.bindings = bindings;
        this.diagnostics = diagnostics;
        this.noStrictParametricProductions = options && options.noStrictParametricProductions || false;
        this.cancellationToken = cancellationToken;
    }

    public get resolver(): Resolver {
        if (!this.innerResolver) {
            this.innerResolver = this.createResolver(this.bindings);
        }

        return this.innerResolver;
    }

    public checkSourceFile(sourceFile: SourceFile): void {
        if (!Dictionary.has(this.checkedFileSet, sourceFile.filename)) {
            const savedNoStrictParametricProductions = this.noStrictParametricProductions;
            this.cancellationToken.throwIfCancellationRequested();
            this.productionParametersByName = new Dictionary<Dictionary<boolean>>();
            this.sourceFile = sourceFile;
            this.diagnostics.setSourceFile(this.sourceFile);

            for (const element of sourceFile.elements) {
                this.preprocessSourceElement(element);
            }

            for (const element of sourceFile.elements) {
                this.checkSourceElement(element);
            }

            this.sourceFile = undefined;
            this.productionParametersByName = undefined;
            this.noStrictParametricProductions = savedNoStrictParametricProductions;
            Dictionary.set(this.checkedFileSet, sourceFile.filename, true);
        }
    }

    protected createResolver(bindings: BindingTable): Resolver {
        return new Resolver(bindings);
    }

    private preprocessSourceElement(node: SourceElement): void {
        switch (node.kind) {
            case SyntaxKind.Define:
                this.preprocessDefine(<Define>node);
                break;
        }
    }

    private preprocessDefine(node: Define) {
        if (!this.checkGrammarDefine(node)) {
            const nodeKey = node.key;
            const nodeKeyText = nodeKey.text;
            switch (nodeKeyText) {
                case "noStrictParametricProductions":
                    this.noStrictParametricProductions = node.valueToken.kind === SyntaxKind.TrueKeyword;
                    break;

                default:
                    this.diagnostics.reportNode(nodeKey, Diagnostics.Cannot_find_name_0_, nodeKeyText);
                    break;
            }
        }
    }

    private checkGrammarDefine(node: Define): boolean {
        if (!node.key || !node.key.text) {
            return this.reportGrammarError(node.defineKeyword.end, Diagnostics._0_expected, tokenToString(SyntaxKind.Identifier));
        }

        if (!node.valueToken) {
            return this.reportGrammarError(node.key.end, Diagnostics._0_expected, formatList([SyntaxKind.TrueKeyword, SyntaxKind.FalseKeyword]));
        }
    }

    private checkSourceElement(node: SourceElement): void {
        switch (node.kind) {
            case SyntaxKind.Production:
                this.checkProduction(<Production>node);
                break;

            case SyntaxKind.InvalidSourceElement:
                this.reportInvalidSourceElement(<SourceElement>node);
                break;
        }
    }

    private checkProduction(node: Production): void {
        this.checkGrammarProduction(node);

        if (this.noStrictParametricProductions) {
            this.checkProductionNonStrict(node);
        }
        else {
            this.checkProductionStrict(node);
        }

        if (node.body) {
            switch (node.body.kind) {
                case SyntaxKind.OneOfList:
                    this.checkOneOfList(<OneOfList>node.body);
                    break;

                case SyntaxKind.RightHandSideList:
                    this.checkRightHandSideList(<RightHandSideList>node.body);
                    break;

                case SyntaxKind.RightHandSide:
                    this.checkRightHandSide(<RightHandSide>node.body);
                    break;
            }
        }
    }

    private checkProductionNonStrict(node: Production) {
        this.checkIdentifier(node.name);

        if (node.parameterList) {
            this.checkParameterList(node.parameterList);
        }
    }

    private getProductionParametersByName(node: Production) {
        const id = node.id;
        const productionParametersByName = this.productionParametersByName;
        if (Dictionary.has(productionParametersByName, id)) {
            return Dictionary.get(productionParametersByName, id);
        }

        const parameterList = node.parameterList;
        const parameters = parameterList ? parameterList.elements : undefined;
        const parameterCount = parameters ? parameters.length : 0;
        const parametersByName = new Dictionary<boolean>();
        for (let i = 0; i < parameterCount; i++) {
            const parameter = parameters[i];
            const parameterName = parameter ? parameter.name : undefined;
            const parameterNameText = parameterName ? parameterName.text : undefined;
            if (parameterNameText && !Dictionary.has(parametersByName, parameterNameText)) {
                Dictionary.set(parametersByName, parameterNameText, true);
            }
        }

        Dictionary.set(productionParametersByName, id, parametersByName);
        return parametersByName;
    }

    private checkProductionStrict(thisProduction: Production) {
        const thisProductionName = thisProduction.name;
        const thisProductionNameText = thisProductionName.text;
        const thisProductionSymbol = this.checkIdentifier(thisProductionName);
        const thisProductionParameterList = thisProduction.parameterList;
        const thisProductionParameters = thisProductionParameterList ? thisProductionParameterList.elements : undefined;
        const thisProductionParameterCount = thisProductionParameters ? thisProductionParameters.length : 0;
        const firstProduction = <Production>this.bindings.getDeclarations(thisProductionSymbol)[0];
        if (thisProductionParameterCount) {
            this.checkParameterList(thisProduction.parameterList);
        }

        if (firstProduction === thisProduction) {
            return;
        }

        if (/test\.grammar$/.test(this.sourceFile.filename) && thisProductionNameText === "D") debugger;

        const thisProductionParameterNames = this.getProductionParametersByName(thisProduction);
        const firstProductionParameterList = firstProduction.parameterList;
        const firstProductionParameters = firstProductionParameterList ? firstProductionParameterList.elements : undefined;
        const firstProductionParameterCount = firstProductionParameters ? firstProductionParameters.length : 0;
        const firstProductionParameterNames = this.getProductionParametersByName(firstProduction);
        for (let i = 0; i < firstProductionParameterCount; i++) {
            const firstProductionParameter = firstProductionParameters[i];
            const firstProductionParameterName = firstProductionParameter.name;
            const firstProductionParameterNameText = firstProductionParameterName.text;
            if (!Dictionary.has(thisProductionParameterNames, firstProductionParameterNameText)) {
                this.diagnostics.reportNode(thisProductionName, Diagnostics.Production_0_is_missing_parameter_1_All_definitions_of_production_0_must_specify_the_same_formal_parameters, thisProductionNameText, firstProductionParameterNameText);
            }
        }

        for (let i = 0; i < thisProductionParameterCount; i++) {
            const thisProductionParameter = thisProductionParameters[i];
            const thisProductionParameterName = thisProductionParameter.name;
            const thisProductionParameterNameText = thisProductionParameterName.text;
            if (!Dictionary.has(firstProductionParameterNames, thisProductionParameterNameText)) {
                this.diagnostics.reportNode(firstProduction, Diagnostics.Production_0_is_missing_parameter_1_All_definitions_of_production_0_must_specify_the_same_formal_parameters, thisProductionNameText, thisProductionParameterNameText);
            }
        }
    }

    private checkGrammarProduction(node: Production): boolean {
        let pos = node.name.end;
        if (node.parameterList) {
            pos = node.parameterList.end;
        }

        if (!node.colonToken) {
            return this.reportGrammarError(pos, Diagnostics._0_expected, tokenToString(SyntaxKind.ColonToken));
        }

        pos += node.colonToken.end;
        if (!node.body) {
            return this.reportGrammarError(pos, Diagnostics._0_expected, formatList([
                SyntaxKind.OneOfList,
                SyntaxKind.RightHandSide,
            ]));
        }

        switch (node.body.kind) {
            case SyntaxKind.OneOfList:
            case SyntaxKind.RightHandSide:
            case SyntaxKind.RightHandSideList:
                break;

            default:
                return this.reportGrammarError(pos, Diagnostics._0_expected, formatList([
                    SyntaxKind.OneOfList,
                    SyntaxKind.RightHandSide,
                ]));
        }

        return false;
    }

    private checkParameterList(node: ParameterList): void {
        this.checkGrammarParameterList(node);

        for (const element of node.elements) {
            this.checkParameter(element);
        }
    }

    private checkGrammarParameterList(node: ParameterList): boolean {
        if (!node.openParenToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBracketToken));
        }

        if (node.openParenToken.kind === SyntaxKind.OpenParenToken) {
            return this.reportGrammarErrorForNode(node.openParenToken, Diagnostics.Obsolete_0_, `Support for using parenthesis to enclose production parameter lists is deprecated and may be removed in a future update. Please switch to bracket's ('[', ']') when enclosing production parameter lists.`)
        }

        if (!node.elements) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.Identifier));
        }

        if (!node.closeParenToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.CloseBracketToken));
        }
    }

    private checkParameter(node: Parameter): void {
        this.checkIdentifier(node.name);
    }

    private checkOneOfList(node: OneOfList): void {
        this.checkGrammarOneOfList(node);

        if (node.terminals) {
            const terminalSet = new Dictionary<boolean>();
            for (const terminal of node.terminals) {
                const text = terminal.text;
                if (Dictionary.has(terminalSet, text)) {
                    this.diagnostics.reportNode(terminal, Diagnostics.Duplicate_terminal_0_, text);
                }
                else {
                    Dictionary.set(terminalSet, text, true);
                    this.checkTerminal(terminal);
                }
            }
        }
    }

    private checkGrammarOneOfList(node: OneOfList): boolean {
        if (!node.oneKeyword) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OneKeyword));
        }

        if (!node.ofKeyword) {
            return this.reportGrammarError(node.oneKeyword.end, Diagnostics._0_expected, tokenToString(SyntaxKind.OfKeyword));
        }

        if (!node.terminals) {
            return this.reportGrammarError(node.ofKeyword.end, Diagnostics._0_expected, tokenToString(SyntaxKind.Terminal));
        }

        if (node.openIndentToken && !node.closeIndentToken) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.DedentToken));
        }

        return false;
    }

    private checkRightHandSideList(node: RightHandSideList): void {
        this.checkGrammarRightHandSideList(node);

        if (node.elements) {
            for (const element of node.elements) {
                this.checkRightHandSide(element);
            }
        }
    }

    private checkGrammarRightHandSideList(node: RightHandSideList): boolean {
        if (!node.openIndentToken) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.IndentToken));
        }

        if (!node.elements || node.elements.length === 0) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, formatList([
                SyntaxKind.Terminal,
                SyntaxKind.Identifier,
                SyntaxKind.OpenBracketToken
            ]));
        }

        if (!node.closeIndentToken) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.DedentToken));
        }

        return false;
    }

    private checkRightHandSide(node: RightHandSide): void {
        this.checkSymbolSpan(node.head);
        if (node.reference) {
            this.checkLinkReference(node.reference);
        }
    }

    private checkLinkReference(node: LinkReference) {
        this.checkGrammarLinkReference(node);
    }

    private checkGrammarLinkReference(node: LinkReference): boolean {
        if (!node.text) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, "string");
        }

        return false;
    }

    private checkSymbolSpan(node: SymbolSpan): void {
        this.checkGrammarSymbolSpan(node);
        this.checkSymbolSpanOrHigher(node.symbol);

        if (node.next) {
            this.checkSymbolSpanRest(node.next);
        }
    }

    private checkGrammarSymbolSpan(node: SymbolSpan): boolean {
        if (!node.symbol) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, formatList([
                SyntaxKind.UnicodeCharacterLiteral,
                SyntaxKind.Terminal,
                SyntaxKind.Identifier,
                SyntaxKind.OpenBracketToken,
                SyntaxKind.Prose
            ]));
        }

        if (node.next) {
            if (node.symbol.kind === SyntaxKind.Prose) {
                return this.reportGrammarError(node.symbol.end, Diagnostics._0_expected, tokenToString(SyntaxKind.LineTerminatorToken));
            }
        }

        return false;
    }

    private checkSymbolSpanOrHigher(node: LexicalSymbol): void {
        if (node.kind === SyntaxKind.Prose) {
            this.checkProse(<Prose>node);
            return;
        }

        this.checkSymbolOrHigher(node);
    }

    private checkProse(node: Prose): void {
        for (const fragment of node.fragments) {
            this.checkProseFragment(fragment);
        }
    }

    private checkSymbolSpanRest(node: SymbolSpan): void {
        this.checkGrammarSymbolSpanRest(node);
        this.checkSymbolOrHigher(node.symbol);

        if (node.next) {
            this.checkSymbolSpanRest(node.next);
        }
    }

    private checkGrammarSymbolSpanRest(node: SymbolSpan): boolean {
        if (!node.symbol) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, formatList([
                SyntaxKind.UnicodeCharacterLiteral,
                SyntaxKind.Terminal,
                SyntaxKind.Identifier,
                SyntaxKind.OpenBracketToken,
                SyntaxKind.LineTerminatorToken
            ]));
        }

        if (node.symbol.kind === SyntaxKind.Prose) {
            return this.reportGrammarError(node.symbol.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.LineTerminatorToken));
        }

        if (node.next && node.next.kind === SyntaxKind.Prose) {
            return this.reportGrammarError(node.next.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.LineTerminatorToken));
        }

        return false;
    }

    private checkSymbolOrHigher(node: LexicalSymbol): void {
        if (isAssertion(node)) {
            this.checkAssertion(<Assertion>node);
            return;
        }

        this.checkButNotSymbolOrHigher(node);
    }

    private checkAssertion(node: Assertion): void {
        switch (node.kind) {
            case SyntaxKind.EmptyAssertion:
                this.checkEmptyAssertion(<EmptyAssertion>node);
                break;

            case SyntaxKind.LookaheadAssertion:
                this.checkLookaheadAssertion(<LookaheadAssertion>node);
                break;

            case SyntaxKind.LexicalGoalAssertion:
                this.checkLexicalGoalAssertion(<LexicalGoalAssertion>node);
                break;

            case SyntaxKind.NoSymbolHereAssertion:
                this.checkNoSymbolHereAssertion(<NoSymbolHereAssertion>node);
                break;

            case SyntaxKind.ParameterValueAssertion:
                this.checkParameterValueAssertion(<ParameterValueAssertion>node);
                break;

            case SyntaxKind.ProseAssertion:
                this.checkProseAssertion(<ProseAssertion>node);
                break;

            case SyntaxKind.InvalidAssertion:
                this.reportInvalidAssertion(<Assertion>node);
                break;
        }
    }

    private checkGrammarAssertionHead(node: Assertion): boolean {
        if (!node.openBracketToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBracketToken));
        }

        return false;
    }

    private checkGrammarAssertionTail(node: Assertion): boolean {
        if (!node.closeBracketToken) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.CloseBracketToken));
        }

        return false;
    }

    private checkEmptyAssertion(node: EmptyAssertion): void {
        this.checkGrammarAssertionHead(node) || this.checkGrammarEmptyAssertion(node) || this.checkGrammarAssertionTail(node);
    }

    private checkGrammarEmptyAssertion(node: EmptyAssertion): boolean {
        if (!node.emptyKeyword) {
            return this.reportGrammarError(node.openBracketToken.end, Diagnostics._0_expected, tokenToString(SyntaxKind.EmptyKeyword, /*quoted*/ true));
        }
    }

    private checkLookaheadAssertion(node: LookaheadAssertion): void {
        this.checkGrammarAssertionHead(node) || this.checkGrammarLookaheadAssertion(node) || this.checkGrammarAssertionTail(node);

        if (node.lookahead) {
            if (node.lookahead.kind === SyntaxKind.SymbolSet) {
                this.checkSymbolSet(<SymbolSet>node.lookahead);
                return;
            }

            this.checkSymbolSpanRest(<SymbolSpan>node.lookahead);
        }
    }

    private checkGrammarLookaheadAssertion(node: LookaheadAssertion): boolean {
        if (!node.lookaheadKeyword) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.LookaheadKeyword, /*quoted*/ true));
        }

        if (!node.operatorToken) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, formatList([
                SyntaxKind.EqualsEqualsToken,
                SyntaxKind.ExclamationEqualsToken,
                SyntaxKind.LessThanMinusToken,
                SyntaxKind.LessThanExclamationToken
            ]));
        }

        switch (node.operatorToken.kind) {
            case SyntaxKind.EqualsEqualsToken:
            case SyntaxKind.ExclamationEqualsToken:
            case SyntaxKind.LessThanMinusToken:
            case SyntaxKind.LessThanExclamationToken:
                break;

            default:
                return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, formatList([
                    SyntaxKind.EqualsEqualsToken,
                    SyntaxKind.ExclamationEqualsToken,
                    SyntaxKind.LessThanMinusToken,
                    SyntaxKind.LessThanExclamationToken
                ]));
        }

        if (!node.lookahead) {
            switch (node.operatorToken.kind) {
                case SyntaxKind.EqualsEqualsToken:
                case SyntaxKind.ExclamationEqualsToken:
                    return this.reportGrammarError(node.operatorToken.end, Diagnostics._0_expected, tokenToString(SyntaxKind.Terminal));

                case SyntaxKind.LessThanMinusToken:
                case SyntaxKind.LessThanExclamationToken:
                    return this.reportGrammarError(node.operatorToken.end, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBraceToken));
            }
        }

        switch (node.operatorToken.kind) {
            case SyntaxKind.EqualsEqualsToken:
            case SyntaxKind.ExclamationEqualsToken:
                if (node.lookahead.kind !== SyntaxKind.SymbolSpan) {
                    return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, formatList([
                        SyntaxKind.Terminal,
                        SyntaxKind.Identifier,
                        SyntaxKind.UnicodeCharacterLiteral
                    ]));
                }

                break;

            case SyntaxKind.LessThanMinusToken:
            case SyntaxKind.LessThanExclamationToken:
                if (node.lookahead.kind !== SyntaxKind.SymbolSet) {
                    return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBraceToken));
                }

                break;
        }

        return false;
    }

    private checkSymbolSet(node: SymbolSet): void {
        this.checkGrammarSymbolSet(node);

        if (node.elements) {
            for (const element of node.elements) {
                this.checkSymbolSpanRest(element);
            }
        }
    }

    private checkGrammarSymbolSet(node: SymbolSet): boolean {
        if (!node.openBraceToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBraceToken));
        }

        if (!node.elements) {
            return this.reportGrammarError(node.openBraceToken.end, Diagnostics._0_expected, formatList([
                SyntaxKind.Identifier,
                SyntaxKind.Terminal,
                SyntaxKind.UnicodeCharacterLiteral
            ]));
        }

        if (!node.closeBraceToken) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.CloseBraceToken));
        }

        return false;
    }

    private checkLexicalGoalAssertion(node: LexicalGoalAssertion): void {
        this.checkGrammarAssertionHead(node) || this.checkGrammarLexicalGoalAssertion(node) || this.checkGrammarAssertionTail(node);

        if (node.symbol) {
            this.checkIdentifier(node.symbol);
        }
    }

    private checkGrammarLexicalGoalAssertion(node: LexicalGoalAssertion): boolean {
        if (!node.lexicalKeyword) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.LexicalKeyword));
        }

        if (!node.goalKeyword) {
            return this.reportGrammarError(node.lexicalKeyword.end, Diagnostics._0_expected, tokenToString(SyntaxKind.GoalKeyword));
        }

        if (!node.symbol) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.Identifier));
        }

        return false;
    }

    private checkNoSymbolHereAssertion(node: NoSymbolHereAssertion): void {
        this.checkGrammarAssertionHead(node) || this.checkGrammarNoSymbolHereAssertion(node) || this.checkGrammarAssertionTail(node);

        if (node.symbols) {
            for (const symbol of node.symbols) {
                this.checkPrimarySymbol(symbol);
            }
        }
    }

    private checkGrammarNoSymbolHereAssertion(node: NoSymbolHereAssertion): boolean {
        if (!node.noKeyword) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.NoKeyword));
        }

        if (!node.symbols || node.symbols.length <= 0) {
            return this.reportGrammarError(node.noKeyword.end, Diagnostics._0_expected, formatList([
                SyntaxKind.Identifier,
                SyntaxKind.Terminal,
                SyntaxKind.UnicodeCharacterLiteral
            ]));
        }

        if (!node.hereKeyword) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.HereKeyword));
        }

        return false;
    }

    private checkParameterValueAssertion(node: ParameterValueAssertion): void {
        this.checkGrammarAssertionHead(node) || this.checkGrammarParameterValueAssertion(node) || this.checkGrammarAssertionTail(node);

        if (node.name) {
            this.checkIdentifier(node.name);
        }
    }

    private checkGrammarParameterValueAssertion(node: ParameterValueAssertion): boolean {
        if (node.operatorToken) {
            switch (node.operatorToken.kind) {
                case SyntaxKind.TildeToken:
                case SyntaxKind.PlusToken:
                    break;

                default:
                    return this.reportGrammarErrorForNode(node.operatorToken, Diagnostics.Unexpected_token_0_, tokenToString(node.operatorToken.kind));
            }
        }

        return false;
    }

    private checkProseAssertion(node: ProseAssertion): void {
        this.checkGrammarProseAssertionHead(node) || this.checkGrammarAssertionTail(node);

        for (const fragment of node.fragments) {
            this.checkProseFragment(fragment);
        }
    }

    private checkGrammarProseAssertionHead(node: Assertion): boolean {
        if (!node.openBracketToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBracketGreaterThanToken));
        }

        return false;
    }

    private checkProseFragment(fragment: ProseFragment): void {
        switch (fragment.kind) {
            case SyntaxKind.Nonterminal:
                this.checkNonterminal(<Nonterminal>fragment, /*allowOptional*/ false);
                break;

            case SyntaxKind.Terminal:
                this.checkTerminal(<Terminal>fragment, /*allowOptional*/ false);
                break;

            case SyntaxKind.ProseFull:
            case SyntaxKind.ProseHead:
            case SyntaxKind.ProseMiddle:
            case SyntaxKind.ProseTail:
                this.checkProseFragmentLiteral(<ProseFragmentLiteral>fragment);
                break;
        }
    }

    private checkProseFragmentLiteral(node: ProseFragmentLiteral): void {
        if (typeof node.text !== "string") {
            this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.UnicodeCharacterLiteral));
        }
    }

    private reportInvalidAssertion(node: Assertion): void {
        if (this.checkGrammarAssertionHead(node)) {
            return;
        }

        this.reportGrammarError(node.openBracketToken.end, Diagnostics._0_expected, formatList([
            SyntaxKind.LookaheadKeyword,
            SyntaxKind.LexicalKeyword,
            SyntaxKind.NoKeyword,
            SyntaxKind.TildeToken,
            SyntaxKind.PlusToken
        ]));
    }

    private checkButNotSymbolOrHigher(node: LexicalSymbol) {
        if (node.kind === SyntaxKind.ButNotSymbol) {
            this.checkButNotSymbol(<ButNotSymbol>node);
            return;
        }

        this.checkUnarySymbolOrHigher(node);
    }

    private checkButNotSymbol(node: ButNotSymbol): void {
        this.checkGrammarButNotSymbol(node);
        this.checkUnarySymbolOrHigher(node.left);
        this.checkUnarySymbolOrHigher(node.right);
    }

    private checkGrammarButNotSymbol(node: ButNotSymbol): boolean {
        if (!node.butKeyword) {
            return this.reportGrammarErrorForNode(node.notKeyword || node.right, Diagnostics._0_expected, tokenToString(SyntaxKind.ButKeyword));
        }

        if (!node.notKeyword) {
            return this.reportGrammarErrorForNode(node.right, Diagnostics._0_expected, tokenToString(SyntaxKind.NotKeyword));
        }

        if (!node.right) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, formatList([
                SyntaxKind.Identifier,
                SyntaxKind.Terminal,
                SyntaxKind.UnicodeCharacterLiteral,
                SyntaxKind.OneKeyword
            ]));
        }

        return false;
    }

    private checkUnarySymbolOrHigher(node: LexicalSymbol) {
        if (node.kind === SyntaxKind.OneOfSymbol) {
            this.checkOneOfSymbol(<OneOfSymbol>node);
            return;
        }

        this.checkOptionalSymbolOrHigher(node);
    }

    private checkOneOfSymbol(node: OneOfSymbol): void {
        this.checkGrammarOneOfSymbol(node);

        if (node.symbols) {
            for (const symbol of node.symbols) {
                this.checkPrimarySymbol(symbol);
            }
        }
    }

    private checkGrammarOneOfSymbol(node: OneOfSymbol): boolean {
        if (!node.oneKeyword) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OneKeyword));
        }

        if (!node.ofKeyword) {
            return this.reportGrammarError(node.oneKeyword.end, Diagnostics._0_expected, tokenToString(SyntaxKind.OfKeyword));
        }

        if (!node.symbols || node.symbols.length <= 0) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, formatList([
                SyntaxKind.Identifier,
                SyntaxKind.Terminal,
                SyntaxKind.UnicodeCharacterLiteral
            ]));
        }

        return false;
    }

    private checkOptionalSymbolOrHigher(node: LexicalSymbol): void {
        this.checkPrimarySymbol(node, true);
    }

    private checkPrimarySymbol(node: LexicalSymbol, allowOptional?: boolean): void {
        switch (node.kind) {
            case SyntaxKind.Terminal:
                this.checkTerminal(<Terminal>node, allowOptional);
                break;

            case SyntaxKind.UnicodeCharacterLiteral:
                this.checkUnicodeCharacterLiteral(<UnicodeCharacterLiteral>node, allowOptional);
                break;

            case SyntaxKind.UnicodeCharacterRange:
                this.checkUnicodeCharacterRange(<UnicodeCharacterRange>node);
                break;

            case SyntaxKind.Nonterminal:
                this.checkNonterminal(<Nonterminal>node, allowOptional);
                break;

            case SyntaxKind.AtToken:
                this.checkPlaceholder(<LexicalSymbol>node);
                break;

            default:
                this.reportInvalidSymbol(<LexicalSymbol>node);
                break;
        }
    }

    private checkGrammarOptionalSymbol(node: OptionalSymbol, allowOptional: boolean) {
        if (node.questionToken) {
            if (!allowOptional || node.questionToken.kind !== SyntaxKind.QuestionToken) {
                return this.reportGrammarErrorForNode(node.questionToken, Diagnostics.Unexpected_token_0_, tokenToString(node.questionToken.kind));
            }
        }

        return false;
    }

    private checkTerminal(node: Terminal, allowOptional?: boolean): void {
        this.checkGrammarOptionalSymbol(node, allowOptional) || this.checkGrammarTerminal(node);
    }

    private checkGrammarTerminal(node: Terminal): boolean {
        if (typeof node.text !== "string" || node.text.length === 0) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.Terminal));
        }

        return false;
    }

    private checkGrammarUnicodeCharacterRange(node: UnicodeCharacterRange): boolean {
        if (!node.left) {
            return this.reportGrammarErrorForNode(node.throughKeyword || node.right || node, Diagnostics._0_expected, tokenToString(SyntaxKind.UnicodeCharacterLiteral));
        }
        if (!node.throughKeyword) {
            return this.reportGrammarErrorForNode(node.right || node, Diagnostics._0_expected, tokenToString(SyntaxKind.ThroughKeyword));
        }
        if (!node.right) {
            return this.reportGrammarError(node.end, Diagnostics._0_expected, tokenToString(SyntaxKind.UnicodeCharacterLiteral));
        }
        return false;
    }

    private checkUnicodeCharacterRange(node: UnicodeCharacterRange): void {
        this.checkGrammarUnicodeCharacterRange(node);
        this.checkUnicodeCharacterLiteral(node.left);
        this.checkUnicodeCharacterLiteral(node.right);
    }

    private checkUnicodeCharacterLiteral(node: UnicodeCharacterLiteral, allowOptional?: boolean): void {
        this.checkGrammarOptionalSymbol(node, allowOptional) || this.checkGrammarUnicodeCharacterLiteral(node);
    }

    private checkGrammarUnicodeCharacterLiteral(node: UnicodeCharacterLiteral): boolean {
        if (typeof node.text !== "string" || node.text.length === 0) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.UnicodeCharacterLiteral));
        }

        return false;
    }

    private checkPlaceholder(node: LexicalSymbol): void {
    }

    private checkNonterminal(node: Nonterminal, allowOptional?: boolean): void {
        this.checkGrammarOptionalSymbol(node, allowOptional);

        if (this.noStrictParametricProductions) {
            this.checkNonterminalNonStrict(node);
        }
        else {
            this.checkNonterminalStrict(node);
        }
    }

    private checkNonterminalNonStrict(node: Nonterminal): void {
        this.checkIdentifier(node.name);

        if (node.argumentList) {
            this.checkArgumentList(node.argumentList);
        }
    }

    private checkNonterminalStrict(node: Nonterminal): void {
        const nonterminalName = node.name;
        const productionSymbol = this.checkIdentifier(nonterminalName);
        if (productionSymbol) {
            const production = <Production>this.bindings.getDeclarations(productionSymbol)[0];
            const parameterCount = production.parameterList ? production.parameterList.elements.length : 0;
            const argumentCount = node.argumentList ? node.argumentList.elements.length : 0;
            const nameSet = new Dictionary<boolean>();

            // Check each argument has a matching parameter.
            for (let i = 0; i < argumentCount; i++) {
                const argument = node.argumentList.elements[i];
                const argumentName = argument.name;
                const argumentNameText = argumentName.text;
                if (Dictionary.has(nameSet, argumentNameText)) {
                    this.diagnostics.reportNode(argumentName, Diagnostics.Argument_0_cannot_be_specified_multiple_times, argumentNameText);
                }
                else {
                    Dictionary.set(nameSet, argumentNameText, true);
                    const parameterSymbol = this.resolveSymbol(production, argumentNameText, SymbolKind.Parameter);
                    if (!parameterSymbol) {
                        this.diagnostics.reportNode(argumentName, Diagnostics.Production_0_does_not_have_a_parameter_named_1_, productionSymbol.name, argumentNameText);
                    }
                }
            }

            // Check each parameter has a matching argument.
            for (let i = 0; i < parameterCount; i++) {
                const parameter = production.parameterList.elements[i];
                const parameterName = parameter.name;
                const parameterNameText = parameterName.text;
                if (!Dictionary.has(nameSet, parameterNameText)) {
                    this.diagnostics.reportNode(nonterminalName, Diagnostics.There_is_no_argument_given_for_parameter_0_, parameterNameText);
                }
            }
        }

        if (node.argumentList) {
            this.checkArgumentList(node.argumentList);
        }
    }

    private checkArgumentList(node: ArgumentList): void {
        this.checkGrammarArgumentList(node);

        if (node.elements) {
            for (const element of node.elements) {
                this.checkArgument(element);
            }
        }
    }

    private checkGrammarArgumentList(node: ArgumentList): boolean {
        if (!node.openParenToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.OpenBracketToken));
        }

        if (node.openParenToken.kind === SyntaxKind.OpenParenToken) {
            return this.reportGrammarErrorForNode(node.openParenToken, Diagnostics.Obsolete_0_, `Support for using parenthesis to enclose an argument list is deprecated and may be removed in a future update. Please switch to bracket's ('[', ']') when enclosing argument lists.`)
        }

        if (!node.elements) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.Identifier));
        }

        if (!node.closeParenToken) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, tokenToString(SyntaxKind.CloseBracketToken));
        }

        return false;
    }

    private checkArgument(node: Argument): void {
        this.checkGrammarArgument(node);
        this.checkIdentifier(node.name);
    }

    private checkGrammarArgument(node: Argument): boolean {
        if (node.operatorToken
            && node.operatorToken.kind !== SyntaxKind.QuestionToken
            && node.operatorToken.kind !== SyntaxKind.PlusToken
            && node.operatorToken.kind !== SyntaxKind.TildeToken) {
            return this.reportGrammarErrorForNode(node.operatorToken, Diagnostics.Unexpected_token_0_, tokenToString(node.operatorToken.kind));
        }

        if (!node.operatorToken && !this.noStrictParametricProductions) {
            return this.reportGrammarError(node.pos, Diagnostics._0_expected, formatList([SyntaxKind.QuestionToken, SyntaxKind.PlusToken, SyntaxKind.TildeToken]));
        }

        return false;
    }

    private reportInvalidSymbol(node: LexicalSymbol): void {
        this.reportGrammarErrorForNode(node, Diagnostics._0_expected, formatList([
            SyntaxKind.Terminal,
            SyntaxKind.Identifier,
            SyntaxKind.OpenBracketToken,
            SyntaxKind.OneKeyword
        ]));
    }

    private checkIdentifier(node: Identifier): Symbol {
        this.checkGrammarIdentifier(node);

        if (node.text) {
            const parent = this.bindings.getParent(node);
            if (parent) {
                let symbol: Symbol;
                switch (parent.kind) {
                    case SyntaxKind.Parameter:
                        symbol = this.resolveSymbol(node, node.text, SymbolKind.Parameter);

                        let declarationSymbol = this.bindings.getSymbol(parent);
                        if (declarationSymbol !== symbol) {
                            this.diagnostics.reportNode(node, Diagnostics.Duplicate_identifier_0_, node.text);
                        }

                        return symbol;

                    case SyntaxKind.Production:
                        return this.bindings.getSymbol(parent);

                    case SyntaxKind.LookaheadAssertion:
                    case SyntaxKind.Nonterminal:
                        symbol = this.resolveSymbol(node, node.text, SymbolKind.Production, Diagnostics.Cannot_find_name_0_);
                        break;

                    case SyntaxKind.Argument:
                        const argument = <Argument>parent;
                        if (argument.operatorToken && argument.operatorToken.kind === SyntaxKind.QuestionToken) {
                            symbol = this.resolveSymbol(node, node.text, SymbolKind.Parameter);
                            if (!symbol) {
                                const production = <Production>this.bindings.getAncestor(argument, SyntaxKind.Production);
                                this.diagnostics.reportNode(node, Diagnostics.Production_0_does_not_have_a_parameter_named_1_, production.name.text, node.text);
                            }
                        }
                        else {
                            // get the symbol of the parameter of the target production
                            const nonterminal = <Nonterminal>this.bindings.getAncestor(parent, SyntaxKind.Nonterminal);
                            if (nonterminal && nonterminal.name && nonterminal.name.text) {
                                const productionSymbol = this.resolveSymbol(node, nonterminal.name.text, SymbolKind.Production);
                                if (productionSymbol) {
                                    const production = <Production>this.bindings.getDeclarations(productionSymbol)[0];
                                    symbol = this.resolveSymbol(production, node.text, SymbolKind.Parameter);
                                    if (!symbol) {
                                        this.diagnostics.reportNode(node, Diagnostics.Production_0_does_not_have_a_parameter_named_1_, production.name.text, node.text);
                                    }
                                }
                            }
                        }

                        break;
                }

                this.bindings.setSymbol(node, symbol);
                return symbol;
            }
        }

        return undefined;
    }

    private checkGrammarIdentifier(node: Identifier): boolean {
        if (typeof node.text === "undefined" || node.text.length <= 0) {
            return this.reportGrammarErrorForNode(node, Diagnostics._0_expected, tokenToString(SyntaxKind.Identifier));
        }

        return false;
    }

    private reportInvalidSourceElement(node: SourceElement): void {
        this.reportGrammarErrorForNode(node, Diagnostics._0_expected, formatList([
            SyntaxKind.Production
        ]));
    }

    private resolveSymbol(location: Node, name: string, meaning: SymbolKind, diagnosticMessage?: Diagnostic): Symbol {
        const result = this.bindings.resolveSymbol(location, name, meaning);
        if (!result && diagnosticMessage) {
            this.diagnostics.reportNode(location, diagnosticMessage, name);
        }

        return result;
    }

    private reportGrammarError(pos: number, diagnosticMessage: Diagnostic, arg0?: any, arg1?: any, arg2?: any) {
        this.diagnostics.report(pos, diagnosticMessage, arg0, arg1, arg2);
        return true;
    }

    private reportGrammarErrorForNode(location: Node, diagnosticMessage: Diagnostic, arg0?: any, arg1?: any, arg2?: any) {
        this.diagnostics.reportNode(location, diagnosticMessage, arg0, arg1, arg2);
        return true;
    }
}

export class Resolver {
    private bindings: BindingTable;

    constructor(bindings: BindingTable) {
        this.bindings = bindings;
    }

    public getParent(node: Node): Node {
        return this.bindings.getParent(node);
    }

    public createNavigator(node: Node): NodeNavigator {
        if (node.kind === SyntaxKind.SourceFile) {
            return new NodeNavigator(<SourceFile>node);
        }
        else {
            const parent = this.bindings.getParent(node);
            if (parent) {
                const navigator = this.createNavigator(parent);
                if (navigator && navigator.moveToFirstChild(child => child === node)) {
                    return navigator;
                }
            }
        }

        return undefined;
    }

    public getSourceFileOfNode(node: Node) {
        return <SourceFile>this.bindings.getAncestor(node, SyntaxKind.SourceFile);
    }

    public getDeclarations(node: Identifier) {
        const parent = this.bindings.getParent(node);

        let symbol = this.bindings.getSymbol(node);
        if (!symbol) {
            symbol = this.bindings.resolveSymbol(node, node.text, getSymbolMeaning(parent));
        }

        if (symbol) {
            return this.bindings.getDeclarations(symbol);
        }

        return [];
    }

    public getReferences(node: Identifier) {
        const symbol = this.bindings.getParent(node).kind === SyntaxKind.Parameter
            ? this.bindings.resolveSymbol(node, node.text, SymbolKind.Parameter)
            : this.bindings.resolveSymbol(node, node.text, SymbolKind.Production);

        if (symbol) {
            return this.bindings.getReferences(symbol);
        }

        return [];
    }

    public getProductionLinkId(node: Identifier): string {
        const symbol = this.bindings.resolveSymbol(node, node.text, SymbolKind.Production);
        if (symbol) {
            return symbol.name;
        }

        return undefined;
    }

    public getRightHandSideLinkId(node: RightHandSide, includePrefix: boolean): string {
        let linkId: string;
        if (node.reference && node.reference.text) {
            linkId = node.reference.text.replace(/[^a-z0-9]+/g, '-');
        }
        else {
            const digest = new RightHandSideDigest();
            linkId = digest.computeHash(node).toLowerCase();
        }

        if (includePrefix) {
            const production = <Production>this.bindings.getAncestor(node, SyntaxKind.Production);
            const productionId = this.getProductionLinkId(production.name);
            return productionId + "-" + linkId;
        }

        return linkId;
    }
}

class RightHandSideDigest {
    private spaceRequested: boolean;
    private writer: StringWriter;

    public computeHash(node: RightHandSide): string {
        this.writer = new StringWriter();
        this.writeNode(node.head);

        const hash = createHash("sha1");
        hash.update(this.writer.toString(), "utf8");

        const digest = hash.digest("hex");
        return digest.substr(0, 8);
    }

    private writeNode(node: Node) {
        if (!node) {
            return;
        }

        switch (node.kind) {
            case SyntaxKind.Terminal: this.writeTerminal(<Terminal>node); break;
            case SyntaxKind.UnicodeCharacterLiteral: this.writeUnicodeCharacterLiteral(<UnicodeCharacterLiteral>node); break;
            case SyntaxKind.Prose: this.writeProse(<Prose>node); break;
            case SyntaxKind.Nonterminal: this.writeNonterminal(<Nonterminal>node); break;
            case SyntaxKind.EmptyAssertion: this.writeEmptyAssertion(<EmptyAssertion>node); break;
            case SyntaxKind.LexicalGoalAssertion: this.writeLexicalGoalAssertion(<LexicalGoalAssertion>node); break;
            case SyntaxKind.LookaheadAssertion: this.writeLookaheadAssertion(<LookaheadAssertion>node); break;
            case SyntaxKind.NoSymbolHereAssertion: this.writeNoSymbolHereAssertion(<NoSymbolHereAssertion>node); break;
            case SyntaxKind.ParameterValueAssertion: this.writeParameterValueAssertion(<ParameterValueAssertion>node); break;
            case SyntaxKind.ProseAssertion: this.writeProseAssertion(<ProseAssertion>node); break;
            case SyntaxKind.ProseFull: this.writeProseFragmentLiteral(<ProseFragmentLiteral>node); break;
            case SyntaxKind.ProseHead: this.writeProseFragmentLiteral(<ProseFragmentLiteral>node); break;
            case SyntaxKind.ProseMiddle: this.writeProseFragmentLiteral(<ProseFragmentLiteral>node); break;
            case SyntaxKind.ProseTail: this.writeProseFragmentLiteral(<ProseFragmentLiteral>node); break;
            case SyntaxKind.UnicodeCharacterRange: this.writeUnicodeCharacterRange(<UnicodeCharacterRange>node); break;
            case SyntaxKind.ButNotSymbol: this.writeButNotSymbol(<ButNotSymbol>node); break;
            case SyntaxKind.OneOfSymbol: this.writeOneOfSymbol(<OneOfSymbol>node); break;
            case SyntaxKind.SymbolSpan: this.writeSymbolSpan(<SymbolSpan>node); break;
            case SyntaxKind.SymbolSet: this.writeSymbolSet(<SymbolSet>node); break;
            case SyntaxKind.ArgumentList: this.writeArgumentList(<ArgumentList>node); break;
            case SyntaxKind.Argument: this.writeArgument(<Argument>node); break;
            case SyntaxKind.Identifier: this.writeIdentifier(<Identifier>node); break;
            default:
                if ((node.kind >= SyntaxKind.FirstKeyword && node.kind <= SyntaxKind.LastKeyword) ||
                    (node.kind >= SyntaxKind.FirstPunctuation && node.kind <= SyntaxKind.LastPunctuation)) {
                    this.writeToken(node);
                    break;
                }
                else {
                    forEachChild(node, child => this.writeNode(child));
                    break;
                }
        }
    }

    private write(text: string) {
        if (text) {
            if (this.spaceRequested && this.writer.size > 0) {
                this.spaceRequested = false;
                this.writer.write(" ");
            }

            this.writer.write(text);
        }
    }

    private writeToken(node: Node) {
        this.write(tokenToString(node.kind));
        this.spaceRequested = true;
    }

    private writeTerminal(node: Terminal) {
        this.write("`");
        this.write(node.text);
        this.write("`");
        this.writeNode(node.questionToken);
        this.spaceRequested = true;
    }

    private writeUnicodeCharacterLiteral(node: UnicodeCharacterLiteral) {
        this.write("<");
        this.write(node.text);
        this.write(">");
        this.writeNode(node.questionToken);
        this.spaceRequested = true;
    }

    private writeProse(node: Prose) {
        this.write("> ");
        for (const fragment of node.fragments) {
            this.writeNode(fragment);
        }
    }

    private writeNonterminal(node: Nonterminal) {
        this.writeNode(node.name);
        this.writeNode(node.argumentList);
        this.writeNode(node.questionToken);
        this.spaceRequested = true;
    }

    private writeArgumentList(node: ArgumentList) {
        this.write("[");
        for (let i = 0; i < node.elements.length; ++i) {
            if (i > 0) {
                this.write(", ");
            }

            this.writeNode(node.elements[i]);
        }

        this.write("]");
    }

    private writeArgument(node: Argument) {
        this.writeNode(node.operatorToken);
        this.writeNode(node.name);
    }

    private writeEmptyAssertion(node: EmptyAssertion) {
        this.write("[empty]");
        this.spaceRequested = true;
    }

    private writeLexicalGoalAssertion(node: LexicalGoalAssertion) {
        this.write("[lexical goal ");
        this.writeNode(node.symbol);
        this.spaceRequested = false;
        this.write("]");
        this.spaceRequested = true;
    }

    private writeLookaheadAssertion(node: LookaheadAssertion) {
        this.write("[lookahead ");
        this.writeNode(node.operatorToken);
        this.writeNode(node.lookahead);
        this.spaceRequested = false;
        this.write("]");
        this.spaceRequested = true;
    }

    private writeNoSymbolHereAssertion(node: NoSymbolHereAssertion) {
        this.write("[no ");
        for (let i = 0; i < node.symbols.length; ++i) {
            if (i > 0) {
                this.write(" or ");
            }

            this.writeNode(node.symbols[i]);
            this.spaceRequested = false;
        }

        this.write(" here]");
    }

    private writeParameterValueAssertion(node: ParameterValueAssertion) {
        this.write("[");
        this.writeToken(node.operatorToken);
        this.spaceRequested = false;
        this.writeNode(node.name);
        this.write("]");
        this.spaceRequested = true;
    }

    private writeProseAssertion(node: ProseAssertion) {
        this.write("[>");
        this.spaceRequested = false;
        for (const fragment of node.fragments) {
            if (fragment.kind === SyntaxKind.Identifier) {
                this.write("|");
                this.writeNode(fragment);
                this.spaceRequested = false;
                this.write("|");
            }
            else {
                this.writeNode(fragment);
            }
        }
        this.write("]");
        this.spaceRequested = true;
    }

    private writeProseFragmentLiteral(node: ProseFragmentLiteral) {
        this.write(node.text);
    }

    private writeUnicodeCharacterRange(node: UnicodeCharacterRange) {
        this.writeNode(node.left);
        this.writeNode(node.throughKeyword);
        this.writeNode(node.right);
        this.spaceRequested = true;
    }

    private writeButNotSymbol(node: ButNotSymbol) {
        this.writeNode(node.left);
        this.writeNode(node.butKeyword);
        this.writeNode(node.notKeyword);
        this.writeNode(node.right);
        this.spaceRequested = true;
    }

    private writeOneOfSymbol(node: OneOfSymbol) {
        this.write("one of ");
        for (let i = 0; i < node.symbols.length; ++i) {
            if (i > 0) {
                this.write(" or ");
            }

            this.writeNode(node.symbols[i]);
            this.spaceRequested = false;
        }

        this.spaceRequested = true;
    }

    private writeSymbolSpan(node: SymbolSpan) {
        this.writeNode(node.symbol);
        this.writeNode(node.next);
    }

    private writeSymbolSet(node: SymbolSet) {
        this.write("{ ");
        for (let i = 0; i < node.elements.length; ++i) {
            if (i > 0) {
                this.write(", ");
            }

            this.writeNode(node.elements[i]);
            this.spaceRequested = false;
        }

        this.write(" }");
        this.spaceRequested = true;
    }

    private writeIdentifier(node: Identifier) {
        this.write(node.text);
    }
}

function isAssertion(node: LexicalSymbol) {
    if (node) {
        switch (node.kind) {
            case SyntaxKind.EmptyAssertion:
            case SyntaxKind.LookaheadAssertion:
            case SyntaxKind.LexicalGoalAssertion:
            case SyntaxKind.NoSymbolHereAssertion:
            case SyntaxKind.ParameterValueAssertion:
            case SyntaxKind.ProseAssertion:
            case SyntaxKind.InvalidAssertion:
                return true;
        }
    }

    return false;
}

function getSymbolMeaning(node: Node) {
    switch (node.kind) {
        case SyntaxKind.Parameter:
        case SyntaxKind.Argument:
        case SyntaxKind.ParameterValueAssertion:
            return SymbolKind.Parameter;
    }

    return SymbolKind.Production;
}