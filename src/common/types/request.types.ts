/** Shape of `req.user` set by JWT / API-key auth (see `ValidatedUser` in token-validation.service). */
export interface RequestUser {
  id: string;
  email: string;
  role: string;
  companyId?: string;
  companyRole?: string;
  isApiAuthenticated: boolean;
  firstName?: string;
  lastName?: string;
}

export interface AuthenticatedRequest extends Request {
  user: RequestUser;
}
