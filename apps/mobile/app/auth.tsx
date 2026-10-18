import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { errorMessage, ownerNameError } from "@zerolux/chat";
import type { Invitation } from "@zerolux/chat";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useAuthentication } from "../src/auth";
import { setPendingInvite, usePendingInvite } from "../src/invite";
import { useKernel, useSession } from "../src/kernel";

export default function Authenticate() {
  const auth = useAuthentication();
  const kernel = useKernel();
  const { chat } = useSession();
  const [existing, setExisting] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  // Joining with an invitation: it is read with no account, and says when it is used up.
  const invite = usePendingInvite();
  const [invitation, setInvitation] = useState<Invitation>();
  const [inviteError, setInviteError] = useState("");
  const health = auth?.health;
  const read = auth?.invitation;
  useEffect(() => {
    if (!invite || !health || !read) return;
    let current = true;
    read(invite).then(
      (next) => current && setInvitation(next),
      (e: unknown) => current && setInviteError(errorMessage(e)),
    );
    return () => {
      current = false;
    };
    // Read again when the workspace is verified again, not at every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite, health]);
  // In the workspace, the invitation is used.
  const member = auth?.identity?.actor_id;
  useEffect(() => {
    if (member) setPendingInvite(null);
  }, [member]);
  if (!auth) return null;
  const joining = invite && !inviteError ? invite : undefined;
  const enrollment =
    auth.identity?.setup_required ?? auth.health?.auth.setup_required ?? false;
  const signup =
    (enrollment || Boolean(joining)) && !existing && !auth.identity;
  const invalid =
    !auth.identity &&
    (!email.trim() ||
      !password ||
      (signup &&
        (Boolean(ownerNameError(name)) ||
          !password ||
          confirmation !== password)));

  async function submit() {
    if (!auth || auth.busy || auth.loading || invalid || !auth.health) return;
    setError("");
    const accepted = auth.identity
      ? await auth.claim(joining)
      : signup
        ? await auth.signUp(name, email, password, joining)
        : await auth.signIn(email, password, joining);
    if (accepted) {
      setPassword("");
      setConfirmation("");
    }
  }
  async function changeKernel() {
    if (!chat.canLeave()) {
      setError(
        "Sign in and resolve pending chat messages before changing kernels.",
      );
      return;
    }
    try {
      await kernel.forget();
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  return (
    <SafeArea className="flex-1 bg-background">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="grow justify-center gap-5 p-6"
      >
        <Wordmark height={22} />
        <View className="gap-2">
          <Text className="text-[32px] font-light tracking-tight">
            {joining ? "Join " : ""}
            {auth.health?.workspace.name ?? "Your workspace"}
          </Text>
          <Text className="text-base leading-6 text-muted-foreground">
            {auth.loading
              ? "Verifying the workspace…"
              : invite && inviteError
                ? `This invitation can no longer be used (${inviteError}). Ask for a new one.`
                : joining
                  ? auth.identity
                    ? "Join this workspace with the account you are signed in to."
                    : invitation
                      ? `${invitation.invited_by} invited you. Create your account, or sign in with one you already have.`
                      : "Reading the invitation…"
                  : auth.identity
                    ? enrollment
                      ? "Bind your account to this workspace’s existing owner. Nothing in the company is recreated."
                      : "This account is not a member of this workspace. Sign out to use another account."
                    : signup
                      ? "Create your account to become this workspace’s owner."
                      : "Sign in to your workspace."}
          </Text>
        </View>
        {auth.health && !auth.loading && (
          <>
            {auth.identity ? (
              <Text className="text-sm text-muted-foreground">
                {auth.identity.user.email}
              </Text>
            ) : (
              <>
                {signup && (
                  <View className="gap-2">
                    <Text className="text-sm">Your name</Text>
                    <Input
                      accessibilityLabel="Your name"
                      value={name}
                      onChangeText={setName}
                      autoComplete="name"
                      editable={!auth.busy}
                    />
                    {name && ownerNameError(name) ? (
                      <Text className="text-sm text-destructive">
                        {ownerNameError(name)}
                      </Text>
                    ) : null}
                  </View>
                )}
                <View className="gap-2">
                  <Text className="text-sm">Email</Text>
                  <Input
                    accessibilityLabel="Email"
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete="email"
                    editable={!auth.busy}
                  />
                </View>
                <View className="gap-2">
                  <Text className="text-sm">Password</Text>
                  <Input
                    accessibilityLabel="Password"
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    autoComplete={signup ? "new-password" : "current-password"}
                    editable={!auth.busy}
                    onSubmitEditing={() => void submit()}
                  />
                </View>
                {signup && (
                  <View className="gap-2">
                    <Text className="text-sm">Confirm password</Text>
                    <Input
                      accessibilityLabel="Confirm password"
                      value={confirmation}
                      onChangeText={setConfirmation}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="new-password"
                      editable={!auth.busy}
                      onSubmitEditing={() => void submit()}
                    />
                    {confirmation && confirmation !== password ? (
                      <Text className="text-sm text-destructive">
                        The passwords do not match.
                      </Text>
                    ) : null}
                  </View>
                )}
              </>
            )}
            {(!auth.identity || enrollment || joining) && (
              <Button
                disabled={auth.busy || Boolean(invalid)}
                onPress={() => void submit()}
              >
                <Text>
                  {auth.busy
                    ? "Please wait…"
                    : auth.identity
                      ? joining
                        ? "Join workspace"
                        : "Claim workspace"
                      : signup
                        ? joining
                          ? "Join"
                          : "Create account"
                        : "Sign in"}
                </Text>
              </Button>
            )}
            {!auth.identity && (enrollment || joining) && (
              <Button
                variant="ghost"
                disabled={auth.busy}
                onPress={() => {
                  setExisting(!existing);
                  setPassword("");
                }}
              >
                <Text>
                  {existing
                    ? "Create an account instead"
                    : "Already created an account? Sign in"}
                </Text>
              </Button>
            )}
            {auth.identity && (
              <Button
                variant="outline"
                disabled={auth.busy}
                onPress={() => void auth.signOut()}
              >
                <Text>Sign out</Text>
              </Button>
            )}
          </>
        )}
        {error || auth.error ? (
          <Text accessibilityRole="alert" className="text-sm text-destructive">
            {error || auth.error}
          </Text>
        ) : null}
        {!auth.loading && (
          <Button
            variant="outline"
            disabled={auth.busy}
            onPress={() => void auth.refresh()}
          >
            <Text>Verify connection again</Text>
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={auth.busy}
          onPress={() => {
            setPendingInvite(null);
            void changeKernel();
          }}
        >
          <Text>
            {invite ? "Use another link" : "Connect to another kernel"}
          </Text>
        </Button>
      </ScrollView>
    </SafeArea>
  );
}
