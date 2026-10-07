'use client';

import { useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { brand } from '@/lib/brand';

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function useApi() {
  const { getToken } = useAuth();

  return useCallback(
    async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const token = await getToken();
      let res: Response;
      try {
        res = await fetch(`${SERVER_URL}/api${path}`, {
          ...init,
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...init.headers,
          },
        });
      } catch {
        throw new ApiError(0, `Can’t reach the ${brand.product} server. Check that it’s running.`);
      }
      if (res.status === 204) return undefined as T;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, body.error ?? `Request failed (${res.status}).`);
      return body as T;
    },
    [getToken],
  );
}
