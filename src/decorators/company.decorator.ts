import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Decorator to get the company ID from the request
 * Works with both JWT auth and API key auth
 */
export const CompanyId = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user?.companyId || request.company?.id;
});

/**
 * Decorator to get the full company object from the request
 */
export const CurrentCompany = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.company;
});

/**
 * Decorator to get the company role from the request
 */
export const CompanyRole = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user?.companyRole;
});
