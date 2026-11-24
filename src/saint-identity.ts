import { parseUsaintIdentity, SchoolError, SchoolSsoVerificationError, type SchoolHttpClient } from '@alms/ssu-api';

export const saintIdentityPage = 'https://saint.ssu.ac.kr/webSSUMain/main_student.jsp';

function isObservedPortalShell(error: unknown): boolean {
  if (!(error instanceof SchoolSsoVerificationError) || error.code !== 'authentication_required'
    || error.verificationStage !== 'identity_parse' || error.identityShape !== 'missing_both'
    || error.portalShape !== 'literal_navigation') return false;
  const markup = error.portalMarkup, navigation = error.portalNavigation;
  return markup?.identityContainerPresent === false && markup.studentRowPresent === false
    && markup.studentValuePresent === false && markup.nameValuePresent === false && markup.passwordFormPresent === false
    && navigation?.scriptPlacement === 'nested_or_expression' && navigation.scriptTarget === 'saint_sso_entry'
    && navigation.formTarget === 'none' && navigation.metaRefreshTarget === 'none';
}

/** A known intermediate page permits one reread of the fixed identity page. The embedded navigation and callback artifact are never used. */
export async function verifySaintIdentityWithReread(client: Pick<SchoolHttpClient, 'get'>, studentId: string,
  initial: () => Promise<ReturnType<typeof parseUsaintIdentity>>) {
  try { return await initial(); }
  catch (error) { if (!isObservedPortalShell(error)) throw error; }
  const response = await client.get(saintIdentityPage, { redirects: 'reject' }).catch(error => {
    if (error instanceof SchoolError) throw new SchoolSsoVerificationError(error.code, 'portal_page', error.retryable);
    throw error;
  });
  if (response.url !== saintIdentityPage || response.status !== 200) throw new SchoolSsoVerificationError('unexpected_response', 'portal_page');
  return parseUsaintIdentity(response.body, studentId);
}
