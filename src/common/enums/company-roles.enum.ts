export enum CompanyRoles {
  ADMIN = 'admin',
  MEMBER = 'member',
  OWNER = 'owner',
}

export const CompanyRoleValues = [
  CompanyRoles.ADMIN,
  CompanyRoles.MEMBER,
  CompanyRoles.OWNER,
] as const;
