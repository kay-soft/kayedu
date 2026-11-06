"use client";

import { useEffect } from "react";

import { forgetStaleExperienceAction } from "@/app/[locale]/(auth)/actions";

/**
 * The hub found a remembered experience this account no longer holds, or one
 * the app never wrote (D-W34). It has already ignored it; a Server Component
 * cannot delete a cookie, so this asks once from the browser. A lost request
 * costs nothing: the value stays ignored and the next visit asks again.
 */
export function ForgetStaleExperience() {
  useEffect(() => {
    void forgetStaleExperienceAction();
  }, []);
  return null;
}
