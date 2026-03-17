"use client";

import {
  type DefaultError,
  type QueryKey,
  type UseMutationOptions,
  type UseQueryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CACHE_TIERS } from "@/lib/shared/query-tiers";

type CacheTier = (typeof CACHE_TIERS)[keyof typeof CACHE_TIERS];

/**
 * Wrapper around useQuery that merges cache tier defaults.
 */
export function useAppQuery<TData = unknown, TError = DefaultError>(
  options: UseQueryOptions<TData, TError> & { tier: CacheTier },
) {
  const { tier, ...queryOptions } = options;
  return useQuery<TData, TError>({
    ...tier,
    ...queryOptions,
  });
}

/**
 * Wrapper around useMutation that invalidates related query keys on success.
 */
export function useAppMutation<
  TData = unknown,
  TError = DefaultError,
  TVariables = void,
  TContext = unknown,
>(
  options: UseMutationOptions<TData, TError, TVariables, TContext> & {
    invalidateKeys?: readonly QueryKey[];
  },
) {
  const queryClient = useQueryClient();
  const { invalidateKeys, onSuccess, ...mutationOptions } = options;

  return useMutation<TData, TError, TVariables, TContext>({
    ...mutationOptions,
    onSuccess: (...args) => {
      if (invalidateKeys) {
        for (const key of invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key as QueryKey });
        }
      }
      onSuccess?.(...args);
    },
  });
}
