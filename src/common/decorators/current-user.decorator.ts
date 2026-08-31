// common/decorators/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { RequestUser } from '../types/request.types';

export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as RequestUser;

    return data ? user?.[data] : user;
  },
);
