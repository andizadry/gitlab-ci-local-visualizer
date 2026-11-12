"""Core rules evaluator for the Pipeline Rules Simulator feature.

Pure Python standard library only (re, fnmatch). No network I/O. No eval()/exec().

This module provides the offline evaluation engine shared by the CLI
(ci_preview.py --simulate) and the Webview. It implements:

  - Tokenizer / recursive-descent Parser (AST) / unparse for rules:if
  - Evaluator (boolean semantics for ==, !=, =~, !~, &&, ||, truthiness, null)
  - VariableResolver (precedence: scenario > job > global > builtin)
  - match_paths (glob for changes/exists via fnmatch)
  - match_rules (rules first-match), when->status mapping
  - evaluate_workflow (workflow:rules gate)
  - match_only_except (legacy only/except)
  - SimulationRunner (orchestrates per-job evaluation)

See .kiro/specs/pipeline-rules-simulator/design.md for the full contract.
"""

import re
import fnmatch

from ci_inputs import expand_variables


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------
class TokenizeError(Exception):
    """Raised when the tokenizer encounters an unrecognized character."""


class ParseError(Exception):
    """Raised when the parser cannot build a valid AST."""


class RegexError(Exception):
    """Raised when a regex literal fails to compile."""


class EvalError(Exception):
    """Raised when an AST cannot be evaluated (e.g. invalid operand shape)."""


# ---------------------------------------------------------------------------
# Tokenizer
# ---------------------------------------------------------------------------
class Token:
    """A lexical token with a kind and its source value."""

    __slots__ = ("kind", "value", "flags")

    def __init__(self, kind, value):
        self.kind = kind
        self.value = value
        self.flags = ""

    def __repr__(self):
        return "Token(%r, %r)" % (self.kind, self.value)

    def __eq__(self, other):
        return (
            isinstance(other, Token)
            and self.kind == other.kind
            and self.value == other.value
        )


# Token kinds:
#   OR '||', AND '&&', EQ '==', NE '!=', MATCH '=~', NMATCH '!~',
#   LPAREN '(', RPAREN ')', VARIABLE, STRING, REGEX, NULL

_IDENT_START = re.compile(r"[A-Za-z_]")
_IDENT_CHAR = re.compile(r"[A-Za-z0-9_]")


def tokenize(expr):
    """Tokenize an expression string into a list of Token.

    Raises TokenizeError on any unrecognized character.
    """
    if expr is None:
        raise TokenizeError("expression is None")

    tokens = []
    i = 0
    n = len(expr)

    while i < n:
        ch = expr[i]

        # Whitespace is ignored.
        if ch in " \t\r\n":
            i += 1
            continue

        # Two-character operators first.
        two = expr[i:i + 2]
        if two == "||":
            tokens.append(Token("OR", "||"))
            i += 2
            continue
        if two == "&&":
            tokens.append(Token("AND", "&&"))
            i += 2
            continue
        if two == "==":
            tokens.append(Token("EQ", "=="))
            i += 2
            continue
        if two == "!=":
            tokens.append(Token("NE", "!="))
            i += 2
            continue
        if two == "=~":
            tokens.append(Token("MATCH", "=~"))
            i += 2
            continue
        if two == "!~":
            tokens.append(Token("NMATCH", "!~"))
            i += 2
            continue

        # Parentheses.
        if ch == "(":
            tokens.append(Token("LPAREN", "("))
            i += 1
            continue
        if ch == ")":
            tokens.append(Token("RPAREN", ")"))
            i += 1
            continue

        # Variable: $VAR or ${VAR}
        if ch == "$":
            if i + 1 < n and expr[i + 1] == "{":
                j = i + 2
                name_chars = []
                while j < n and expr[j] != "}":
                    name_chars.append(expr[j])
                    j += 1
                if j >= n:
                    raise TokenizeError("unterminated ${...} variable at %d" % i)
                name = "".join(name_chars)
                if name == "":
                    raise TokenizeError("empty variable name at %d" % i)
                tokens.append(Token("VARIABLE", name))
                i = j + 1  # skip closing }
                continue
            else:
                j = i + 1
                if j >= n or not _IDENT_START.match(expr[j]):
                    raise TokenizeError("invalid variable name at %d" % i)
                name_chars = []
                while j < n and _IDENT_CHAR.match(expr[j]):
                    name_chars.append(expr[j])
                    j += 1
                tokens.append(Token("VARIABLE", "".join(name_chars)))
                i = j
                continue

        # String: "..." or '...'
        if ch == '"' or ch == "'":
            quote = ch
            j = i + 1
            buf = []
            closed = False
            while j < n:
                cj = expr[j]
                if cj == "\\" and j + 1 < n:
                    # Support escaping of the quote and backslash.
                    nxt = expr[j + 1]
                    if nxt == quote or nxt == "\\":
                        buf.append(nxt)
                        j += 2
                        continue
                    buf.append(cj)
                    j += 1
                    continue
                if cj == quote:
                    closed = True
                    j += 1
                    break
                buf.append(cj)
                j += 1
            if not closed:
                raise TokenizeError("unterminated string starting at %d" % i)
            tokens.append(Token("STRING", "".join(buf)))
            i = j
            continue

        # Regex: /pattern/flags  (flags are optional lowercase letters a-z)
        if ch == "/":
            j = i + 1
            buf = []
            closed = False
            while j < n:
                cj = expr[j]
                if cj == "\\" and j + 1 < n:
                    # Keep escape sequences intact for re.
                    buf.append(cj)
                    buf.append(expr[j + 1])
                    j += 2
                    continue
                if cj == "/":
                    closed = True
                    j += 1
                    break
                buf.append(cj)
                j += 1
            if not closed:
                raise TokenizeError("unterminated regex starting at %d" % i)
            # Collect trailing flags (a-z).
            flags = []
            while j < n and "a" <= expr[j] <= "z":
                flags.append(expr[j])
                j += 1
            pattern = "".join(buf)
            # Encode flags in the token value separated by a NUL that can't
            # appear in source; store as a tuple-ish string. We keep value as
            # the pattern and stash flags by using a composite. Simpler: use a
            # dedicated attribute via value being (pattern, flags) is not str.
            tok = Token("REGEX", pattern)
            tok.flags = "".join(flags)  # dynamic attribute for regex flags
            tokens.append(tok)
            i = j
            continue

        # null keyword / identifiers
        if _IDENT_START.match(ch):
            j = i
            buf = []
            while j < n and _IDENT_CHAR.match(expr[j]):
                buf.append(expr[j])
                j += 1
            word = "".join(buf)
            if word == "null":
                tokens.append(Token("NULL", "null"))
                i = j
                continue
            raise TokenizeError("unexpected identifier %r at %d" % (word, i))

        raise TokenizeError("unexpected character %r at %d" % (ch, i))

    return tokens


# ---------------------------------------------------------------------------
# AST Node types
# ---------------------------------------------------------------------------
class Node:
    """Base AST node."""


class Or(Node):
    def __init__(self, left, right):
        self.left = left
        self.right = right

    def __repr__(self):
        return "Or(%r, %r)" % (self.left, self.right)


class And(Node):
    def __init__(self, left, right):
        self.left = left
        self.right = right

    def __repr__(self):
        return "And(%r, %r)" % (self.left, self.right)


class Compare(Node):
    def __init__(self, op, left, right):
        self.op = op  # '==' | '!=' | '=~' | '!~'
        self.left = left
        self.right = right

    def __repr__(self):
        return "Compare(%r, %r, %r)" % (self.op, self.left, self.right)


class Var(Node):
    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return "Var(%r)" % (self.name,)


class Str(Node):
    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return "Str(%r)" % (self.value,)


class Regex(Node):
    def __init__(self, pattern, flags):
        self.pattern = pattern
        self.flags = flags or ""

    def __repr__(self):
        return "Regex(%r, %r)" % (self.pattern, self.flags)


class Null(Node):
    def __repr__(self):
        return "Null()"


# ---------------------------------------------------------------------------
# Parser (recursive descent)
#
# Precedence (low -> high):
#   1. ||   (left assoc)
#   2. &&   (left assoc)
#   3. == != =~ !~  (non-associative comparison)
#   4. primary: $VAR, string, regex, null, ( expr )
# ---------------------------------------------------------------------------
_COMPARE_KINDS = {"EQ": "==", "NE": "!=", "MATCH": "=~", "NMATCH": "!~"}


class _Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.pos = 0

    def _peek(self):
        if self.pos < len(self.tokens):
            return self.tokens[self.pos]
        return None

    def _advance(self):
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def parse(self):
        if not self.tokens:
            raise ParseError("empty expression")
        node = self._parse_or()
        if self.pos != len(self.tokens):
            tok = self.tokens[self.pos]
            raise ParseError("unexpected token %r" % (tok.value,))
        return node

    def _parse_or(self):
        node = self._parse_and()
        while True:
            tok = self._peek()
            if tok is not None and tok.kind == "OR":
                self._advance()
                right = self._parse_and()
                node = Or(node, right)
            else:
                break
        return node

    def _parse_and(self):
        node = self._parse_compare()
        while True:
            tok = self._peek()
            if tok is not None and tok.kind == "AND":
                self._advance()
                right = self._parse_compare()
                node = And(node, right)
            else:
                break
        return node

    def _parse_compare(self):
        left = self._parse_primary()
        tok = self._peek()
        if tok is not None and tok.kind in _COMPARE_KINDS:
            op = _COMPARE_KINDS[tok.kind]
            self._advance()
            right = self._parse_primary()
            # Non-associative: a == b == c is invalid.
            nxt = self._peek()
            if nxt is not None and nxt.kind in _COMPARE_KINDS:
                raise ParseError("comparison operators are non-associative")
            return Compare(op, left, right)
        return left

    def _parse_primary(self):
        tok = self._peek()
        if tok is None:
            raise ParseError("unexpected end of expression")

        if tok.kind == "LPAREN":
            self._advance()
            node = self._parse_or()
            closing = self._peek()
            if closing is None or closing.kind != "RPAREN":
                raise ParseError("expected closing ')'")
            self._advance()
            return node

        if tok.kind == "VARIABLE":
            self._advance()
            return Var(tok.value)

        if tok.kind == "STRING":
            self._advance()
            return Str(tok.value)

        if tok.kind == "REGEX":
            self._advance()
            return Regex(tok.value, getattr(tok, "flags", ""))

        if tok.kind == "NULL":
            self._advance()
            return Null()

        raise ParseError("unexpected token %r" % (tok.value,))


def parse(expr):
    """Parse an expression string into an AST Node. Raises ParseError."""
    tokens = tokenize(expr)
    return _Parser(tokens).parse()


def _escape_string(value):
    """Escape a string value for canonical double-quoted unparse."""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def unparse(node):
    """Render an AST back to a canonical string (for round-trip)."""
    if isinstance(node, Or):
        return "%s || %s" % (unparse(node.left), unparse(node.right))
    if isinstance(node, And):
        # Wrap Or children so precedence round-trips (a || b) && c.
        left = _wrap_lower(node.left, ("Or",))
        right = _wrap_lower(node.right, ("Or",))
        return "%s && %s" % (left, right)
    if isinstance(node, Compare):
        left = _wrap_lower(node.left, ("Or", "And"))
        right = _wrap_lower(node.right, ("Or", "And"))
        return "%s %s %s" % (left, node.op, right)
    if isinstance(node, Var):
        return "$%s" % node.name
    if isinstance(node, Str):
        return '"%s"' % _escape_string(node.value)
    if isinstance(node, Regex):
        return "/%s/%s" % (node.pattern, node.flags)
    if isinstance(node, Null):
        return "null"
    raise EvalError("cannot unparse node: %r" % (node,))


def _wrap_lower(node, lower_kinds):
    """Wrap a child node in parens if it is one of the lower-precedence kinds."""
    kind = type(node).__name__
    text = unparse(node)
    if kind in lower_kinds:
        return "(%s)" % text
    return text


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------
class Evaluator:
    """Evaluates an AST (or expression string) to a boolean.

    `variables` should be the effective-for-eval mapping (name -> str|None).
    A missing key or a value of None means the variable is undefined.
    """

    def __init__(self, variables):
        self.variables = variables or {}

    # -- variable resolution --
    def _resolve_var(self, name):
        """Return the string value of a variable, or None if undefined."""
        return self.variables.get(name)

    # -- operand as string (None -> None kept for null semantics) --
    def _operand_value(self, node):
        """Return the string value of an operand node, or None if undefined.

        Str -> raw value (no variable expansion).
        Var -> resolved value or None.
        Null -> raised by callers that handle it; not called here for Null.
        """
        if isinstance(node, Str):
            return node.value
        if isinstance(node, Var):
            return self._resolve_var(node.name)
        if isinstance(node, Null):
            # Represented distinctly by comparison logic.
            return None
        raise EvalError("operand is not a value node: %r" % (node,))

    def eval(self, node):
        """Evaluate an AST node to a bool. Raises EvalError/RegexError."""
        if isinstance(node, Or):
            return self.eval(node.left) or self.eval(node.right)
        if isinstance(node, And):
            return self.eval(node.left) and self.eval(node.right)
        if isinstance(node, Compare):
            return self._eval_compare(node)
        if isinstance(node, Var):
            # Bare variable truthiness: defined AND not empty string.
            val = self._resolve_var(node.name)
            return val is not None and val != ""
        if isinstance(node, (Str, Regex, Null)):
            # A lone literal as a boolean operand is not meaningful in
            # GitLab rules; treat only Str truthiness leniently is out of
            # scope. Raise to signal a malformed expression.
            raise EvalError("literal used as boolean operand")
        raise EvalError("cannot evaluate node: %r" % (node,))

    def _eval_compare(self, node):
        op = node.op

        if op in ("=~", "!~"):
            return self._eval_match(node)

        # == and != : handle null specially.
        left_is_null = isinstance(node.left, Null)
        right_is_null = isinstance(node.right, Null)

        if left_is_null or right_is_null:
            # Compare "defined-ness".
            if left_is_null and right_is_null:
                # null == null -> True; null != null -> False
                return True if op == "==" else False
            # Exactly one side is null: the other side must be a Var/Str.
            other = node.right if left_is_null else node.left
            if isinstance(other, Var):
                defined = self._resolve_var(other.name) is not None
            elif isinstance(other, Str):
                # A string literal is always "defined".
                defined = True
            else:
                raise EvalError("invalid null comparison operand")
            # $VAR == null  -> True iff undefined
            # $VAR != null  -> True iff defined
            if op == "==":
                return not defined
            return defined

        # Plain string comparison (case-sensitive). None -> "" for comparison
        # so that an undefined var compares equal to "" only via != semantics?
        # Per spec: == is string-identical; "" matches == "". Undefined var
        # value is None; for non-null comparisons we coerce None to "".
        left_val = self._operand_value(node.left)
        right_val = self._operand_value(node.right)
        lv = "" if left_val is None else left_val
        rv = "" if right_val is None else right_val
        if op == "==":
            return lv == rv
        return lv != rv

    def _eval_match(self, node):
        # Right side MUST be a Regex.
        if not isinstance(node.right, Regex):
            raise EvalError("right operand of %s must be a regex" % node.op)
        # Left side resolves to a string; None -> "".
        left_val = self._operand_value(node.left)
        s = "" if left_val is None else left_val
        flags = 0
        if "i" in node.right.flags:
            flags |= re.I
        try:
            compiled = re.compile(node.right.pattern, flags)
        except re.error as exc:
            raise RegexError(
                "failed to compile regex /%s/: %s" % (node.right.pattern, exc)
            )
        found = compiled.search(s) is not None
        if node.op == "=~":
            return found
        return not found

    def eval_expr(self, expr):
        """Tokenize + parse + evaluate an expression string to a bool."""
        node = parse(expr)
        return self.eval(node)


# ---------------------------------------------------------------------------
# VariableResolver
# ---------------------------------------------------------------------------
class VariableResolver:
    """Resolves effective variables with well-defined precedence.

    Precedence for EVALUATION (if / only:variables):
        scenario > job > global > builtin
    Precedence for OUTPUT (effective_variables):
        scenario > rule_vars > job > global
    A value of None (or absent key) means "undefined".
    """

    def __init__(self, scenario_vars, job_vars, global_vars):
        self.scenario_vars = dict(scenario_vars or {})
        self.job_vars = dict(job_vars or {})
        self.global_vars = dict(global_vars or {})

    def _builtins(self, merged):
        """Compute builtin defaults given the already-merged higher layers.

        Builtins are the LOWEST-priority layer and never override existing
        defined values.
        """
        builtin = {}
        # CI_PIPELINE_SOURCE default 'push' only if absent everywhere else.
        if merged.get("CI_PIPELINE_SOURCE") is None and \
                "CI_PIPELINE_SOURCE" not in merged:
            builtin["CI_PIPELINE_SOURCE"] = "push"
        # Derive CI_COMMIT_REF_NAME from CI_COMMIT_BRANCH then CI_COMMIT_TAG.
        if merged.get("CI_COMMIT_REF_NAME") is None and \
                "CI_COMMIT_REF_NAME" not in merged:
            branch = merged.get("CI_COMMIT_BRANCH")
            tag = merged.get("CI_COMMIT_TAG")
            if branch is not None:
                builtin["CI_COMMIT_REF_NAME"] = branch
            elif tag is not None:
                builtin["CI_COMMIT_REF_NAME"] = tag
        return builtin

    def effective_for_eval(self):
        """Return merged mapping: scenario > job > global > builtin."""
        merged = {}
        # Lowest defined layers first so higher layers overwrite.
        merged.update(self.global_vars)
        merged.update(self.job_vars)
        merged.update(self.scenario_vars)
        # Builtins fill only what is still missing.
        builtin = self._builtins(merged)
        for k, v in builtin.items():
            if k not in merged or merged.get(k) is None:
                merged[k] = v
        return merged

    def effective_for_output(self, rule_vars):
        """Return output mapping: scenario > rule_vars > job > global."""
        merged = {}
        merged.update(self.global_vars)
        merged.update(self.job_vars)
        merged.update(rule_vars or {})
        merged.update(self.scenario_vars)
        return merged

    def get(self, name):
        """Return the effective (eval) value of a variable, or None."""
        return self.effective_for_eval().get(name)


# ---------------------------------------------------------------------------
# Glob matching for changes / exists
# ---------------------------------------------------------------------------
def match_paths(patterns, files):
    """Return True if any pattern matches any file (fnmatch glob).

    An empty/None `files` list yields False. `**` is normalized to `*`.
    """
    if not files:
        return False
    if not patterns:
        return False
    for pattern in patterns:
        if pattern is None:
            continue
        norm = pattern.replace("**", "*")
        for f in files:
            if f is None:
                continue
            if fnmatch.fnmatch(f, norm):
                return True
    return False


# ---------------------------------------------------------------------------
# when -> status mapping
# ---------------------------------------------------------------------------
_WHEN_TO_STATUS = {
    "never": "NEVER",
    "manual": "MANUAL",
    "delayed": "DELAYED",
    "on_success": "RUN",
    "on_failure": "RUN",
    "always": "RUN",
}


def when_to_status(when_effective):
    """Map an effective `when` value to a Status_Job.

    Unknown values fall back to on_success (RUN). Returns (status, note)
    where note is a string describing a fallback (or "").
    """
    if when_effective in _WHEN_TO_STATUS:
        return _WHEN_TO_STATUS[when_effective], ""
    return "RUN", "unknown when %r; fallback on_success" % (when_effective,)


def _resolve_rule_when(rule_when, job_when):
    """Resolve the effective `when` for a matched rule.

    Rule's own `when` wins; else the job's `when`; else on_success.
    """
    if rule_when:
        return rule_when
    if job_when:
        return job_when
    return "on_success"


# ---------------------------------------------------------------------------
# RuleEvalResult factory
# ---------------------------------------------------------------------------
def _rule_result(matched, matched_rule_index, when_effective, clause,
                 reason, rule_variables, error=None):
    return {
        "matched": matched,
        "matched_rule_index": matched_rule_index,
        "when_effective": when_effective,
        "clause": clause,
        "reason": reason,
        "rule_variables": rule_variables or {},
        "error": error,
    }


# ---------------------------------------------------------------------------
# RuleMatcher (rules first-match)
# ---------------------------------------------------------------------------
def match_rules(rules, resolver, changed, exists, job_when):
    """Evaluate a list of `rules` with first-match semantics.

    Returns a RuleEvalResult dict. A rule matches iff every present clause
    (if/changes/exists) matches; a rule with none always matches. Stops at
    the first match. On no match: matched False, index None.
    """
    eval_vars = resolver.effective_for_eval()
    evaluator = Evaluator(eval_vars)

    for idx, rule in enumerate(rules or []):
        if not isinstance(rule, dict):
            # Treat a non-dict rule as an always-match empty rule guard.
            continue

        clauses_present = []
        matched = True
        primary_clause = "none"
        if_expr = rule.get("if")
        changes = rule.get("changes")
        exists_pat = rule.get("exists")

        # if clause
        if if_expr is not None:
            clauses_present.append("if")
            primary_clause = "if"
            try:
                if not evaluator.eval_expr(if_expr):
                    matched = False
            except (TokenizeError, ParseError, RegexError, EvalError) as exc:
                # Propagate as an error result for this rule set.
                return _rule_result(
                    False, None, None, "if",
                    "rule[%d] if: %s (error)" % (idx, if_expr),
                    {}, error=str(exc),
                )

        # changes clause
        if matched and changes is not None:
            clauses_present.append("changes")
            if primary_clause == "none":
                primary_clause = "changes"
            change_list = changes if isinstance(changes, list) else \
                changes.get("paths", []) if isinstance(changes, dict) else []
            if not match_paths(change_list, changed):
                matched = False

        # exists clause
        if matched and exists_pat is not None:
            clauses_present.append("exists")
            if primary_clause == "none":
                primary_clause = "exists"
            exists_list = exists_pat if isinstance(exists_pat, list) else \
                exists_pat.get("paths", []) if isinstance(exists_pat, dict) \
                else []
            if not match_paths(exists_list, exists):
                matched = False

        if matched:
            when_eff = _resolve_rule_when(rule.get("when"), job_when)
            rule_vars = rule.get("variables") or {}
            if primary_clause == "if":
                reason = "rule[%d] if: %s (when: %s)" % (
                    idx, if_expr, when_eff)
            elif primary_clause == "changes":
                reason = "rule[%d] changes (when: %s)" % (idx, when_eff)
            elif primary_clause == "exists":
                reason = "rule[%d] exists (when: %s)" % (idx, when_eff)
            else:
                reason = "rule[%d] (no clause, always match) (when: %s)" % (
                    idx, when_eff)
            return _rule_result(
                True, idx, when_eff, primary_clause, reason, rule_vars,
            )

    return _rule_result(
        False, None, None, "none",
        "tidak ada rule yang match", {},
    )


def explain_rules(rules, resolver, changed, exists, job_when):
    """Evaluasi SEMUA rule (bukan first-match) untuk penjelasan step-by-step.
    Kembalikan list trace: setiap item { index, if, changes, exists, clause_results, matched, when, note }.
    Item pertama yang matched menandai rule efektif (matched True); rule sesudahnya tetap dievaluasi
    untuk transparansi namun ditandai reached=False."""
    eval_vars = resolver.effective_for_eval()
    evaluator = Evaluator(eval_vars)
    trace = []
    decided = False
    for idx, rule in enumerate(rules or []):
        if not isinstance(rule, dict):
            continue
        if_expr = rule.get('if')
        changes = rule.get('changes')
        exists_pat = rule.get('exists')
        clause_results = []
        matched = True
        err = None
        if if_expr is not None:
            try:
                r = bool(evaluator.eval_expr(if_expr))
            except (TokenizeError, ParseError, RegexError, EvalError) as exc:
                r = False; err = str(exc); matched = False
            clause_results.append({'clause': 'if', 'expr': if_expr, 'result': r, 'error': err})
            if not r: matched = False
        if changes is not None:
            change_list = changes if isinstance(changes, list) else (changes.get('paths', []) if isinstance(changes, dict) else [])
            r = match_paths(change_list, changed)
            clause_results.append({'clause': 'changes', 'expr': change_list, 'result': bool(r), 'error': None})
            if not r: matched = False
        if exists_pat is not None:
            exists_list = exists_pat if isinstance(exists_pat, list) else (exists_pat.get('paths', []) if isinstance(exists_pat, dict) else [])
            r = match_paths(exists_list, exists)
            clause_results.append({'clause': 'exists', 'expr': exists_list, 'result': bool(r), 'error': None})
            if not r: matched = False
        when_eff = _resolve_rule_when(rule.get('when'), job_when)
        effective = (matched and not decided)
        trace.append({
            'index': idx,
            'clauses': clause_results if clause_results else [{'clause': 'none', 'expr': None, 'result': True, 'error': None}],
            'matched': bool(matched),
            'when': when_eff,
            'effective': bool(effective),
            'reached': (not decided),
            'error': err,
        })
        if matched and not decided:
            decided = True
    return trace


# ---------------------------------------------------------------------------
# WorkflowGate
# ---------------------------------------------------------------------------
def evaluate_workflow(workflow_rules, resolver, changed, exists):
    """Evaluate workflow:rules with first-match to decide pipeline creation.

    Returns { matched, when, reason, pipeline_created }.
      - no workflow_rules -> pipeline_created True immediately.
      - match when:never OR no match -> pipeline_created False.
      - match non-never -> pipeline_created True.
    """
    if not workflow_rules:
        return {
            "matched": False,
            "when": None,
            "reason": "tanpa workflow:rules; pipeline langsung dibuat",
            "pipeline_created": True,
        }

    result = match_rules(workflow_rules, resolver, changed, exists, None)

    if result.get("error"):
        # A workflow rule error blocks the pipeline defensively.
        return {
            "matched": False,
            "when": None,
            "reason": "workflow:rules error: %s" % result["error"],
            "pipeline_created": False,
        }

    if not result["matched"]:
        return {
            "matched": False,
            "when": None,
            "reason": "tidak ada workflow rule yang match; pipeline diblok",
            "pipeline_created": False,
        }

    when_eff = result["when_effective"]
    if when_eff == "never":
        return {
            "matched": True,
            "when": when_eff,
            "reason": result["reason"],
            "pipeline_created": False,
        }

    return {
        "matched": True,
        "when": when_eff,
        "reason": result["reason"],
        "pipeline_created": True,
        # workflow:rules:variables dari rule yang match: variabel tingkat pipeline untuk semua job.
        "variables": _norm_rule_vars(result.get("rule_variables")),
    }


# ---------------------------------------------------------------------------
# LegacyOnlyExcept
# ---------------------------------------------------------------------------
_SOURCE_KEYWORDS = ("branches", "tags", "merge_requests")


def _normalize_only_except(value):
    """Normalize an only/except value into (refs, variables, changes).

    Accepts a list (treated as refs) or a dict with keys refs/variables/
    changes. Returns (refs_list, variables_list, changes_list) or Nones.
    """
    if value is None:
        return None, None, None
    if isinstance(value, list):
        return list(value), None, None
    if isinstance(value, dict):
        refs = value.get("refs")
        variables = value.get("variables")
        changes = value.get("changes")
        return refs, variables, changes
    # Scalar string -> single ref.
    return [value], None, None


def _ref_keyword_matches(keyword, source, ref_name):
    """Return True if a source keyword matches the current source/ref."""
    if keyword == "branches":
        # push to a branch (not a tag)
        return source == "push" and not ref_name_is_tag_context(source)
    if keyword == "tags":
        return source == "tag"
    if keyword == "merge_requests":
        return source == "merge_request_event"
    return False


def ref_name_is_tag_context(source):
    """Helper kept simple: only 'tag' source is a tag context."""
    return source == "tag"


def _refs_match(refs, source, ref_name):
    """Return True if ref_name (or the source keyword) matches any entry."""
    if not refs:
        return False
    for entry in refs:
        if entry is None:
            continue
        if entry in _SOURCE_KEYWORDS:
            if _ref_keyword_matches(entry, source, ref_name):
                return True
            continue
        # Regex form /pattern/
        if isinstance(entry, str) and len(entry) >= 2 and \
                entry.startswith("/") and entry.endswith("/"):
            pattern = entry[1:-1]
            try:
                if re.search(pattern, ref_name or ""):
                    return True
            except re.error as exc:
                raise RegexError(
                    "failed to compile ref regex %s: %s" % (entry, exc))
            continue
        # Literal ref
        if entry == ref_name:
            return True
    return False


def _variables_match(var_exprs, resolver):
    """Return True if ANY expression in the list evaluates true."""
    if not var_exprs:
        return False
    evaluator = Evaluator(resolver.effective_for_eval())
    for expr in var_exprs:
        if evaluator.eval_expr(expr):
            return True
    return False


def match_only_except(only, except_, resolver, changed, ref_name, source,
                      job_when):
    """Evaluate legacy only/except semantics -> RuleEvalResult.

    Job runs iff it passes ALL present `only` clauses AND is not caught by
    ANY `except` clause; otherwise SKIP.
    """
    try:
        only_refs, only_vars, only_changes = _normalize_only_except(only)
        exc_refs, exc_vars, exc_changes = _normalize_only_except(except_)

        # --- only: must pass every present clause ---
        only_pass = True
        if only is not None:
            if only_refs is not None:
                if not _refs_match(only_refs, source, ref_name):
                    only_pass = False
            if only_pass and only_vars is not None:
                if not _variables_match(only_vars, resolver):
                    only_pass = False
            if only_pass and only_changes is not None:
                if not match_paths(only_changes, changed):
                    only_pass = False

        # --- except: caught if ANY present clause matches ---
        except_caught = False
        if except_ is not None:
            if exc_refs is not None and _refs_match(exc_refs, source, ref_name):
                except_caught = True
            if not except_caught and exc_vars is not None and \
                    _variables_match(exc_vars, resolver):
                except_caught = True
            if not except_caught and exc_changes is not None and \
                    match_paths(exc_changes, changed):
                except_caught = True

        runs = only_pass and not except_caught
    except (TokenizeError, ParseError, RegexError, EvalError) as exc:
        return _rule_result(
            False, None, None, "only",
            "legacy only/except error", {}, error=str(exc),
        )

    if runs:
        when_eff = job_when if job_when else "on_success"
        clause = "only"
        reason = "legacy only/except: job jalan (when: %s)" % when_eff
        return _rule_result(True, None, when_eff, clause, reason, {})

    clause = "except" if except_caught else "only"
    reason = "legacy only/except: job di-skip"
    return _rule_result(False, None, "never", clause, reason, {})


# ---------------------------------------------------------------------------
# SimulationRunner
# ---------------------------------------------------------------------------
def _norm_rule_vars(raw):
    """Normalisasi `rules:variables` menjadi {nama: string}."""
    out = {}
    if isinstance(raw, dict):
        for key, val in raw.items():
            if isinstance(val, dict):
                val = val.get("value", "")
            if val is None:
                val = ""
            elif isinstance(val, bool):
                val = "true" if val else "false"
            out[str(key)] = val if isinstance(val, str) else str(val)
    return out


class SimulationRunner:
    """Orchestrates workflow gating and per-job evaluation over a resolver."""

    @staticmethod
    def _job_sim_result(status, when_effective, matched_rule_index, reason,
                        effective_variables, error=None, trace=None):
        return {
            "status": status,
            "when_effective": when_effective,
            "matched_rule_index": matched_rule_index,
            "trace": trace or [],
            "reason": reason,
            "effective_variables": effective_variables or {},
            "error": error,
        }

    @staticmethod
    def run(resolver_ci, scenario):
        """Run the simulation. See design.md Components / Data Models.

        `resolver_ci` must expose:
            .jobs           dict[name] -> { rules, variables, when, only, except }
            .global_variables  dict
            .workflow_rules    list (optional; defaults to [])
        `scenario` is { variables, changed_files, exists_files }.
        """
        scenario = scenario or {}
        scenario_vars = scenario.get("variables") or {}
        changed = scenario.get("changed_files") or []
        exists = scenario.get("exists_files") or []

        global_vars = getattr(resolver_ci, "global_variables", {}) or {}
        workflow_rules = getattr(resolver_ci, "workflow_rules", None) or []
        jobs = getattr(resolver_ci, "jobs", {}) or {}

        # --- Workflow gate ---
        wf_resolver = VariableResolver(scenario_vars, {}, global_vars)
        workflow = evaluate_workflow(workflow_rules, wf_resolver, changed,
                                     exists)

        results = {}

        # workflow:rules:variables menimpa `variables` global (tetap kalah dari variabel job & skenario).
        workflow_vars = workflow.get("variables") or {}
        if workflow_vars:
            global_vars = dict(global_vars)
            global_vars.update(workflow_vars)

        if not workflow["pipeline_created"]:
            for name in jobs:
                results[name] = SimulationRunner._job_sim_result(
                    "NEVER", "never", None,
                    "pipeline diblok oleh workflow:rules", {},
                )
            return {
                "pipeline_created": False,
                "workflow": {
                    "matched": workflow["matched"],
                    "when": workflow["when"],
                    "reason": workflow["reason"],
                },
                "results": results,
                "child_pipelines": SimulationRunner._children_not_triggered(
                    getattr(resolver_ci, "child_pipelines", None) or {},
                    "pipeline induk diblok oleh workflow:rules"),
            }

        # --- Per-job evaluation ---
        for name, job in jobs.items():
            job = job or {}
            job_vars = job.get("variables") or {}
            job_when = job.get("when")
            resolver = VariableResolver(scenario_vars, job_vars, global_vars)

            try:
                rules = job.get("rules")
                only = job.get("only")
                except_ = job.get("except")

                if rules:  # non-empty list
                    rr = match_rules(rules, resolver, changed, exists,
                                     job_when)
                    if rr.get("error"):
                        results[name] = SimulationRunner._job_sim_result(
                            "SKIP", None, None,
                            "rule error: %s" % rr["error"],
                            resolver.effective_for_output({}),
                            error=rr["error"],
                        )
                        continue
                    jsr = SimulationRunner._build_result_from_rule(rr, resolver)
                    try:
                        jsr["trace"] = explain_rules(rules, resolver, changed, exists, job_when)
                    except Exception:
                        jsr["trace"] = []
                    results[name] = jsr
                elif only is not None or except_ is not None:
                    eff = resolver.effective_for_eval()
                    ref_name = eff.get("CI_COMMIT_REF_NAME") or ""
                    source = eff.get("CI_PIPELINE_SOURCE") or "push"
                    rr = match_only_except(only, except_, resolver, changed,
                                           ref_name, source, job_when)
                    if rr.get("error"):
                        results[name] = SimulationRunner._job_sim_result(
                            "SKIP", None, None,
                            "only/except error: %s" % rr["error"],
                            resolver.effective_for_output({}),
                            error=rr["error"],
                        )
                        continue
                    results[name] = SimulationRunner._build_result_from_rule(
                        rr, resolver)
                else:
                    # tanpa rules/only/except: pakai `when` level job (default on_success)
                    when_eff = job_when if isinstance(job_when, str) and job_when else "on_success"
                    status, note = when_to_status(when_eff)
                    reason = "default (no rules/only/except) (when: %s)" % when_eff
                    if note:
                        reason = "%s [%s]" % (reason, note)
                    results[name] = SimulationRunner._job_sim_result(
                        status, when_eff, None, reason,
                        resolver.effective_for_output({}),
                    )
            except (TokenizeError, ParseError, RegexError, EvalError) as exc:
                results[name] = SimulationRunner._job_sim_result(
                    "SKIP", None, None,
                    "evaluasi gagal: %s" % exc,
                    resolver.effective_for_output({}),
                    error=str(exc),
                )

        # --- include:rules (file yang tidak ikut di-include => job-nya tidak ada) ---
        SimulationRunner._apply_include_gates(
            resolver_ci, results, scenario_vars, global_vars, changed, exists)

        # --- parent-child / multi-project / dynamic child ---
        child_pipelines = SimulationRunner._simulate_children(
            resolver_ci, results, scenario, scenario_vars, global_vars, changed, exists)

        return {
            "pipeline_created": True,
            "workflow": {
                "matched": workflow["matched"],
                "when": workflow["when"],
                "reason": workflow["reason"],
            },
            "results": results,
            "child_pipelines": child_pipelines,
        }

    # ------------------------------------------------------------------
    # include:rules
    # ------------------------------------------------------------------
    @staticmethod
    def _apply_include_gates(resolver_ci, results, scenario_vars, global_vars, changed, exists):
        rels = getattr(resolver_ci, "file_relationships", None) or []
        if not any(isinstance(r.get("spec"), dict) and r["spec"].get("rules") for r in rels):
            return
        gate_resolver = VariableResolver(scenario_vars, {}, global_vars)

        def passes(spec):
            rules = spec.get("rules") if isinstance(spec, dict) else None
            if not rules:
                return True
            try:
                rr = match_rules(rules, gate_resolver, changed, exists, None)
            except (TokenizeError, ParseError, RegexError, EvalError):
                return True  # rules rusak: jangan menyembunyikan job (error sudah tampil di validasi)
            if rr.get("error"):
                return True
            return bool(rr["matched"]) and rr.get("when_effective") != "never"

        by_parent = {}
        for r in rels:
            by_parent.setdefault(r["parent"], []).append(r)
        roots = list(getattr(resolver_ci, "root_files", None) or [str(getattr(resolver_ci, "entry_file", ""))])
        reached = set(roots)
        frontier = list(roots)
        while frontier:
            parent = frontier.pop()
            for r in by_parent.get(parent, []):
                if passes(r.get("spec")) and r["child"] not in reached:
                    reached.add(r["child"])
                    frontier.append(r["child"])
        known = {f["path"] for f in (getattr(resolver_ci, "file_trace", None) or []) if f.get("status") == "OK"}
        excluded = known - reached
        if not excluded:
            return
        for name, job in (getattr(resolver_ci, "jobs", None) or {}).items():
            src = (job or {}).get("source_file")
            if src in excluded:
                results[name] = SimulationRunner._job_sim_result(
                    "NEVER", "never", None,
                    "file sumber tidak di-include (include:rules tidak terpenuhi): %s" % src, {},
                )

    # ------------------------------------------------------------------
    # Downstream pipelines
    # ------------------------------------------------------------------
    @staticmethod
    def _is_predefined(name):
        return str(name).startswith(("CI_", "GITLAB_"))

    @staticmethod
    def _children_not_triggered(metas, reason):
        out = {}
        for bname, meta in (metas or {}).items():
            jobs = (meta or {}).get("jobs") or {}
            out[bname] = {
                "path": meta.get("path"), "kind": meta.get("kind"), "status": meta.get("status"),
                "strategy": meta.get("strategy"), "bridge_status": "NEVER",
                "triggered": False, "reason": reason, "placeholder": not jobs,
                "pipeline_created": False, "forwarded_variables": {},
                "results": {
                    jn: SimulationRunner._job_sim_result("NEVER", "never", None, reason, {})
                    for jn in jobs
                },
                "child_pipelines": SimulationRunner._children_not_triggered(meta.get("children"), reason),
                "summary": {"NEVER": len(jobs)} if jobs else {},
            }
        return out

    @staticmethod
    def _forwarded_variables(bridge_job, bridge_res, meta, scenario_vars, global_vars, pipeline_names):
        """Hitung variabel yang diteruskan bridge job ke pipeline downstream (sesuai trigger:forward)."""
        fwd = meta.get("forward") or {}
        forwarded = {}
        if fwd.get("yaml_variables", True):
            inherit = bridge_job.get("inherit") if isinstance(bridge_job.get("inherit"), dict) else {}
            setting = inherit.get("variables", True)
            if setting is True:
                forwarded.update(global_vars)
            elif isinstance(setting, list):
                forwarded.update({k: v for k, v in global_vars.items() if k in setting})
            forwarded.update(bridge_job.get("variables") or {})
            idx = (bridge_res or {}).get("matched_rule_index")
            rules = bridge_job.get("rules") or []
            if idx is not None and isinstance(idx, int) and idx < len(rules) and isinstance(rules[idx], dict):
                forwarded.update(_norm_rule_vars(rules[idx].get("variables")))
        if fwd.get("pipeline_variables", False):
            forwarded.update({k: v for k, v in scenario_vars.items() if k in pipeline_names})
        # variabel yang merujuk variabel lain (mis. $CI_COMMIT_REF_NAME) di-ekspansi satu level
        env = dict(scenario_vars)
        env.update(forwarded)
        return {k: expand_variables(v, env) if isinstance(v, str) else v for k, v in forwarded.items()}

    @staticmethod
    def _child_scenario(meta, forwarded, scenario_vars, changed, exists):
        if meta.get("kind") == "project":
            default_branch = scenario_vars.get("CI_DEFAULT_BRANCH") or "main"
            branch = meta.get("branch")
            branch = expand_variables(str(branch), dict(scenario_vars, **forwarded)) if branch else default_branch
            project = meta.get("project") or ""
            base = {
                "CI_PIPELINE_SOURCE": "pipeline",
                "CI_DEFAULT_BRANCH": default_branch,
                "CI_COMMIT_BRANCH": branch,
                "CI_COMMIT_REF_NAME": branch,
                "CI_PROJECT_PATH": project,
                "CI_PROJECT_NAME": project.rsplit("/", 1)[-1],
            }
            child_changed, child_exists = [], []   # repo berbeda: daftar file milik parent tidak berlaku
        else:
            base = {k: v for k, v in scenario_vars.items() if SimulationRunner._is_predefined(k)}
            base["CI_PIPELINE_SOURCE"] = "parent_pipeline"
            child_changed, child_exists = list(changed), list(exists)
        variables = dict(base)
        variables.update(forwarded)
        return {
            "variables": variables,
            "changed_files": child_changed,
            "exists_files": child_exists,
            "pipeline_variable_names": sorted(forwarded.keys()),
        }

    @staticmethod
    def _summarize(results):
        summary = {}
        for res in (results or {}).values():
            key = "ERROR" if (res or {}).get("error") else (res or {}).get("status", "?")
            summary[key] = summary.get(key, 0) + 1
        return summary

    @staticmethod
    def _simulate_children(resolver_ci, results, scenario, scenario_vars, global_vars, changed, exists):
        metas = getattr(resolver_ci, "child_pipelines", None) or {}
        resolvers = getattr(resolver_ci, "_child_resolvers", None) or {}
        jobs = getattr(resolver_ci, "jobs", None) or {}
        names = scenario.get("pipeline_variable_names")
        if names is None:
            names = [k for k in scenario_vars if not SimulationRunner._is_predefined(k)]
        pipeline_names = set(names)

        out = {}
        for bname, meta in metas.items():
            bridge_res = results.get(bname) or {}
            status = bridge_res.get("status", "NEVER")
            base = {
                "path": meta.get("path"), "kind": meta.get("kind"), "status": meta.get("status"),
                "strategy": meta.get("strategy"), "bridge_status": status,
            }
            if status in ("NEVER", "SKIP"):
                reason = "bridge job '%s' tidak berjalan (%s): %s" % (bname, status, bridge_res.get("reason"))
                entry = SimulationRunner._children_not_triggered({bname: meta}, reason)[bname]
                entry["bridge_status"] = status
                out[bname] = entry
                continue

            bridge_job = jobs.get(bname) or {}
            forwarded = SimulationRunner._forwarded_variables(
                bridge_job, bridge_res, meta, scenario_vars, global_vars, pipeline_names)
            base["forwarded_variables"] = forwarded
            base["triggered"] = True if status == "RUN" else "conditional"
            base["reason"] = (
                "bridge job berjalan" if status == "RUN"
                else "bridge job %s: child terpicu setelah dijalankan manual/tertunda" % status)

            child = resolvers.get(bname)
            if child is None:
                base.update({"placeholder": True, "pipeline_created": None, "results": {},
                             "child_pipelines": {}, "summary": {},
                             "reason": meta.get("status_detail") or "child tidak tersedia offline"})
                out[bname] = base
                continue

            child_scn = SimulationRunner._child_scenario(meta, forwarded, scenario_vars, changed, exists)
            sim = SimulationRunner.run(child, child_scn)
            base.update(sim)
            base["placeholder"] = False
            base["scenario_variables"] = child_scn["variables"]
            base["summary"] = SimulationRunner._summarize(sim.get("results"))
            out[bname] = base
        return out

    @staticmethod
    def _build_result_from_rule(rr, resolver):
        """Turn a RuleEvalResult into a JobSimResult."""
        if not rr["matched"]:
            return SimulationRunner._job_sim_result(
                "SKIP", None, None, rr["reason"],
                resolver.effective_for_output({}),
            )
        when_eff = rr["when_effective"]
        status, note = when_to_status(when_eff)
        reason = rr["reason"]
        if note:
            reason = "%s [%s]" % (reason, note)
        effective = resolver.effective_for_output(rr.get("rule_variables") or {})
        return SimulationRunner._job_sim_result(
            status, when_eff, rr["matched_rule_index"], reason, effective,
        )
