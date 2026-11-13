// Lua kapsam çözümleyicisi: her tanımlayıcı kullanımını bildirimine bağlar. Lua sözcüksel kapsamlıdır: local'ler
// bildirildikleri bloğun sonuna kadar geçerlidir; local x = x'teki sağdaki x dıştaki x'tir; for değişkenleri ve
// parametreler gövdeye aittir. Bildirimi bulunmayan adlar küreseldir.
import { walk } from './lua.js';

/**
 * @returns {{ decls: Array<{ name, id, kind, init, stmt, reads: object[], writes: object[] }>, globals: Map<string, { reads: object[], writes: object[] }>, dynamic: boolean }}
 *  dynamic: getfenv/setfenv/_G/_ENV/loadstring/load/debug kullanımı (adlar dolaylı okunup yazılabilir)
 */
export function analyze(ast) {
  const decls = [];
  const globals = new Map();
  let dynamic = false;
  const scopes = [new Map()];

  const declare = (id, kind, init = null, stmt = null) => {
    const d = { name: id.name, id, kind, init, stmt, reads: [], writes: [] };
    scopes[scopes.length - 1].set(id.name, d);
    decls.push(d);
    return d;
  };
  const resolve = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name);
    return null;
  };
  const use = (id, mode) => {
    const d = resolve(id.name);
    if (d) { d[mode].push(id); return; }
    if (!globals.has(id.name)) globals.set(id.name, { reads: [], writes: [] });
    globals.get(id.name)[mode].push(id);
    if (['getfenv', 'setfenv', '_G', '_ENV', 'debug'].includes(id.name)) dynamic = true;
  };

  function expr(n) {
    if (!n) return;
    switch (n.type) {
      case 'Identifier': use(n, 'reads'); return;
      case 'FunctionDeclaration': fn(n); return;
      case 'MemberExpression': expr(n.base); return;
      case 'IndexExpression': expr(n.base); expr(n.index); return;
      case 'CallExpression': expr(n.base); n.arguments.forEach(expr); return;
      case 'StringCallExpression': expr(n.base); expr(n.argument); return;
      case 'TableCallExpression': expr(n.base); expr(n.arguments); return;
      case 'TableConstructorExpression':
        for (const f of n.fields) { if (f.type === 'TableKey') expr(f.key); expr(f.value); } // {a = 1}: a alan adıdır, okuma değil
        return;
      case 'BinaryExpression': case 'LogicalExpression': expr(n.left); expr(n.right); return;
      case 'UnaryExpression': expr(n.argument); return;
      default: return;
    }
  }

  function target(t) {
    if (t.type === 'Identifier') use(t, 'writes');
    else if (t.type === 'MemberExpression') expr(t.base);
    else if (t.type === 'IndexExpression') { expr(t.base); expr(t.index); }
  }

  function block(body, pre = () => {}) {
    scopes.push(new Map());
    pre();
    body.forEach(stmt);
    scopes.pop();
  }

  function fn(n) {
    // local function f: ad gövdeden önce bildirilir (özyineleme); function a.b.c(): hedef bir yazma
    if (n.identifier) {
      if (n.isLocal) declare(n.identifier, 'localfunction', n, n);
      else if (n.identifier.type === 'Identifier') use(n.identifier, 'writes');
      else expr(n.identifier.base ?? n.identifier);
    }
    block(n.body, () => {
      for (const p of n.parameters) if (p.type === 'Identifier') declare(p, 'param');
      if (n.identifier?.indexer === ':') declare({ type: 'Identifier', name: 'self' }, 'param');
    });
  }

  function stmt(s) {
    switch (s.type) {
      case 'LocalStatement':
        s.init.forEach(expr);
        s.variables.forEach((v, i) => declare(v, 'local', s.init[i] ?? null, s));
        return;
      case 'AssignmentStatement':
        s.init.forEach(expr);
        s.variables.forEach(target);
        return;
      case 'CallStatement': expr(s.expression); return;
      case 'FunctionDeclaration': fn(s); return;
      case 'ReturnStatement': s.arguments.forEach(expr); return;
      case 'IfStatement':
        for (const c of s.clauses) { if (c.condition) expr(c.condition); block(c.body); }
        return;
      case 'WhileStatement': expr(s.condition); block(s.body); return;
      case 'RepeatStatement':
        // until koşulu gövdenin local'lerini görür
        scopes.push(new Map());
        s.body.forEach(stmt);
        expr(s.condition);
        scopes.pop();
        return;
      case 'DoStatement': block(s.body); return;
      case 'ForNumericStatement':
        expr(s.start); expr(s.end); if (s.step) expr(s.step);
        block(s.body, () => declare(s.variable, 'for'));
        return;
      case 'ForGenericStatement':
        s.iterators.forEach(expr);
        block(s.body, () => s.variables.forEach((v) => declare(v, 'for')));
        return;
      default: return;
    }
  }

  ast.body.forEach(stmt);
  return { decls, globals, dynamic };
}

/** analyze + düğüm eşlemeleri: declOf (Identifier düğümü → bildirim), globalOf (Identifier düğümü → küresel ad) */
export function bind(ast) {
  const a = analyze(ast);
  const declOf = new Map();
  const globalOf = new Map();
  for (const d of a.decls) {
    declOf.set(d.id, d);
    for (const r of d.reads) declOf.set(r, d);
    for (const w of d.writes) declOf.set(w, d);
  }
  for (const [name, g] of a.globals) for (const n of [...g.reads, ...g.writes]) globalOf.set(n, name);
  return { ...a, declOf, globalOf };
}

/** Kod içinde serbest (küresel) olarak kullanılan adlar */
export function freeNames(ast) {
  return new Set(analyze(ast).globals.keys());
}

/** Konumu kapsayan tüm local adları (yaklaşık: konumu içeren bloklarda ondan önce bildirilenler) */
export function localsAt(ast, offset) {
  const names = new Set();
  const visit = (body) => {
    for (const s of body) {
      if (s.range[0] >= offset) break;
      if (s.type === 'LocalStatement') s.variables.forEach((v) => names.add(v.name));
      if (s.type === 'FunctionDeclaration' && s.isLocal && s.identifier) names.add(s.identifier.name);
      if (s.range[1] > offset) {
        // konum bu deyimin içinde: iç bloklara in
        walk(s, (n) => {
          if (!(n.range && n.range[0] <= offset && n.range[1] > offset)) return false;
          if (n.type === 'FunctionDeclaration') n.parameters.forEach((p) => p.name && names.add(p.name));
          if (n.type === 'ForNumericStatement') names.add(n.variable.name);
          if (n.type === 'ForGenericStatement') n.variables.forEach((v) => names.add(v.name));
          if (Array.isArray(n.body) && n !== s) visit(n.body);
          if (n.type === 'IfStatement') for (const c of n.clauses) if (c.range[0] <= offset && c.range[1] > offset) visit(c.body);
          return true;
        });
        if (Array.isArray(s.body)) visit(s.body);
      }
    }
  };
  visit(ast.body);
  return names;
}
