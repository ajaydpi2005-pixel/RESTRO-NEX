import type { Metadata } from "next";
import { ResetPasswordForm } from "@/modules/auth/components/reset-password-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";


export const metadata: Metadata = {
  title: "Reset password",
  description: "Choose a new password for your RestroNex account.",
};

export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Choose a new password</CardTitle>
        <CardDescription>
          You arrived here from a reset link. Set a new password below — you&apos;ll be signed in
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ResetPasswordForm />
      </CardContent>
    </Card>
  );
}
