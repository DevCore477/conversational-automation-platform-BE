export enum UserRole {
  ADMIN = 'admin',
  MEMBER = 'member',
}

export const UserRoleValues = [UserRole.ADMIN, UserRole.MEMBER] as const;
