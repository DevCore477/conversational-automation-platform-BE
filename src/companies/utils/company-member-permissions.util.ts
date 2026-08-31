/**
 * Effective capabilities implied by `companyRole`, aligned with checks in
 * `CompaniesController`, `ApiKeysController`, etc.
 */
export interface CompanyMemberPermissions {
  manageCompanyProfile: boolean;
  manageThemeAndBranding: boolean;
  manageCompanySettings: boolean;
  manageUsers: boolean;
  manageInvitations: boolean;
  /** Only company owners may assign the `owner` company role. */
  assignOwnerRole: boolean;
  manageApiKeys: boolean;
  removeUsers: boolean;
  makeCalls: boolean;
  viewCompanyAndAnalytics: boolean;
}

export function resolveCompanyMemberPermissions(companyRole: string): CompanyMemberPermissions {
  const r = (companyRole.trim() === '' ? 'user' : companyRole).toLowerCase();
  const isOwner = r === 'owner';
  const isAdmin = r === 'admin';
  const isMember = r === 'member';
  const elevated = isOwner || isAdmin;

  return {
    manageCompanyProfile: elevated,
    manageThemeAndBranding: elevated,
    manageCompanySettings: elevated,
    manageUsers: elevated,
    manageInvitations: elevated,
    assignOwnerRole: isOwner,
    manageApiKeys: elevated,
    removeUsers: elevated,
    makeCalls: elevated || isMember,
    viewCompanyAndAnalytics: true,
  };
}
