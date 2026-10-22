import test from 'node:test';
import assert from 'node:assert/strict';
import {SchoolError, SchoolSsoVerificationError} from '@alms/ssu-api';
import {authFailureDiagnostic, rememberAuthFailure} from '../src/auth-diagnostics.js';
import {AppError} from '../src/errors.js';

const markup = {identityContainerPresent: false, studentRowPresent: false, studentValuePresent: false,
  nameValuePresent: false, passwordFormPresent: false};
const shapes = ['identity_markup', 'password_form', 'literal_navigation', 'frame_shell', 'mixed', 'unknown', 'inspection_limited'] as const;
const known = () => new SchoolSsoVerificationError('authentication_required', 'identity_parse', false, 'missing_both', {shape: 'unknown', ...markup});

test('only known SDK identity errors forward fixed portal shapes and exactly five frozen booleans', () => {
  for (const shape of shapes) {
    const error = known();
    Object.assign(error, {portalShape: shape, portalMarkup: {...markup, raw: 'private-body', url: 'private-url', studentId: '90000001'}, cause: 'private-cause'});
    const diagnostic = authFailureDiagnostic(error, 'school_identity');
    assert.equal(diagnostic.portalShape, shape); assert.deepEqual(diagnostic.portalMarkup, markup);
    assert.ok(Object.isFrozen(diagnostic)); assert.ok(Object.isFrozen(diagnostic.portalMarkup));
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-|90000001|raw|url|cause/);
  }
  for (const error of [new Error('private-error'), new SchoolError('authentication_required')]) {
    Object.assign(error, {verificationStage: 'identity_parse', identityShape: 'missing_both', portalShape: 'unknown', portalMarkup: markup});
    assert.equal(authFailureDiagnostic(error).portalShape, undefined);
    assert.equal(authFailureDiagnostic(error).portalMarkup, undefined);
  }
});

test('invalid portal shape, markup and stage/code/identity combinations never become evidence', () => {
  for (const fields of [
    {portalShape: 'private-shape'}, {portalMarkup: {...markup, nameValuePresent: 'private-value'}},
    {portalMarkup: undefined}, {portalMarkup: Object.assign([], markup)},
    {verificationStage: 'portal_page'}, {identityShape: 'id_mismatch'}, {code: 'upstream_unavailable'},
  ]) {
    const error = Object.assign(known(), fields), diagnostic = authFailureDiagnostic(error, 'school_identity');
    assert.equal(diagnostic.portalShape, undefined); assert.equal(diagnostic.portalMarkup, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-/);
  }
  const mismatch = new SchoolSsoVerificationError('identity_mismatch', 'identity_parse', false, 'id_mismatch',
    {shape: 'identity_markup', ...markup, identityContainerPresent: true});
  assert.equal(authFailureDiagnostic(mismatch).portalShape, 'identity_markup');
});

test('normalization keeps only a private copy of same-attempt portal evidence and preserves public errors', () => {
  const normalized = new AppError(401, 'SCHOOL_AUTH_FAILED', 'Existing public message'), before = JSON.stringify(normalized);
  const raw = {...authFailureDiagnostic(known(), 'school_identity'), portalMarkup: {...markup, raw: 'private-body'},
    lmsExchange: {status: 'ready' as const}, schoolTrace: []};
  rememberAuthFailure(normalized, raw);
  raw.portalMarkup.nameValuePresent = true; raw.portalMarkup.raw = 'private-replaced';
  const diagnostic = authFailureDiagnostic(normalized);
  assert.equal(diagnostic.portalShape, 'unknown'); assert.deepEqual(diagnostic.portalMarkup, markup);
  assert.deepEqual(diagnostic.lmsExchange, {status: 'ready'}); assert.deepEqual(diagnostic.schoolTrace, []);
  assert.equal(JSON.stringify(normalized), before);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-|raw/);
});

const navigation = {scriptPlacement: 'outer_statement', scriptTarget: 'saint_sso_entry', formTarget: 'none', metaRefreshTarget: 'none'} as const;
test('known SDK identity failures retain exactly four frozen navigation enums', () => {
  const error = Object.assign(known(), {portalNavigation: {...navigation, destination: 'private-url', token: 'private-token'}});
  const diagnostic = authFailureDiagnostic(error, 'school_identity');
  assert.deepEqual(diagnostic.portalNavigation, navigation); assert.ok(Object.isFrozen(diagnostic.portalNavigation));
  assert.doesNotMatch(JSON.stringify(diagnostic), /private-|destination|token/);
  for (const placement of ['none', 'outer_statement', 'nested_or_expression', 'mixed', 'inspection_limited']) {
    Object.assign(error, {portalNavigation: {...navigation, scriptPlacement: placement}});
    assert.equal(authFailureDiagnostic(error).portalNavigation?.scriptPlacement, placement);
  }
  for (const target of ['none', 'saint_sso_entry', 'saint_identity_page', 'other', 'mixed', 'inspection_limited']) {
    Object.assign(error, {portalNavigation: {...navigation, scriptTarget: target, formTarget: target, metaRefreshTarget: target}});
    assert.deepEqual(authFailureDiagnostic(error).portalNavigation, {...navigation, scriptTarget: target, formTarget: target, metaRefreshTarget: target});
  }
});
test('invalid navigation enums and untrusted or mismatched errors never become evidence', () => {
  for (const value of [undefined, Object.assign([], navigation), {...navigation, scriptPlacement: 'private-value'},
    {...navigation, scriptTarget: '/private-url'}, {...navigation, formTarget: true}, {...navigation, metaRefreshTarget: undefined}]) {
    const error = Object.assign(known(), {portalNavigation: value});
    assert.equal(authFailureDiagnostic(error).portalNavigation, undefined);
  }
  for (const error of [new Error('private-message'), new SchoolError('authentication_required'),
    Object.assign(known(), {portalShape: undefined}), Object.assign(known(), {verificationStage: 'portal_page'})]) {
    Object.assign(error, {portalNavigation: navigation});
    assert.equal(authFailureDiagnostic(error).portalNavigation, undefined);
  }
});
test('private callback normalization copies navigation evidence without changing public error payload', () => {
  const normalized = new AppError(401, 'SCHOOL_AUTH_FAILED', 'Existing public message'), before = JSON.stringify(normalized);
  const raw = {...authFailureDiagnostic(known(), 'school_identity'), portalNavigation: {...navigation, raw: 'private-body'}};
  rememberAuthFailure(normalized, raw);
  raw.portalNavigation.raw = 'private-changed';
  assert.deepEqual(authFailureDiagnostic(normalized).portalNavigation, navigation);
  assert.ok(Object.isFrozen(authFailureDiagnostic(normalized).portalNavigation));
  assert.equal(JSON.stringify(normalized), before); assert.doesNotMatch(JSON.stringify(authFailureDiagnostic(normalized)), /private-|raw/);
});
