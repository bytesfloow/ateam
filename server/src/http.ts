import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from './errors';

export function parseBody<T>(req: Request, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length ? issue.path.join('.') : 'body'}: ${issue.message}`)
      .join('；');
    throw new AppError(400, `请求参数不合法：${detail}`, parsed.error.flatten());
  }
  return parsed.data;
}

export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (!value) throw new AppError(400, `缺少路径参数 ${name}`);
  return value;
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/**
 * API 错误出口：AppError 按其状态码与消息返回 JSON；
 * body 解析失败统一按 400 处理；其余按 500 记录日志。生产入口与测试应用共用。
 */
export const apiErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;
  const error = err as { status?: number; type?: string; message?: string; details?: unknown };
  let status = error instanceof AppError ? error.status : typeof error.status === 'number' ? error.status : 500;
  let message = error instanceof AppError ? error.message : error.message || '服务器内部错误';
  if (error.type === 'entity.parse.failed') {
    status = 400;
    message = '请求体不是合法 JSON';
  }
  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.path} 失败:`, err);
  }
  res.status(status).json({
    error: message,
    ...(error instanceof AppError && error.details !== undefined ? { details: error.details } : {}),
  });
};
