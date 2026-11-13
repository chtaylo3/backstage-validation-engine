/** `true` when `A` and `B` are assignable to each other; used for compile-time shape checks. */
export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
