import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { errorMessage, ownerNameError } from "@zerolux/chat";
import type { Invitation } from "@zerolux/chat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { WorkspaceMark } from "@/components/workspace-mark";
import { useAuthentication } from "../src/auth";
import { setPendingInvite, usePendingInvite } from "../src/invite";
import { keptName, useKernel, useSession } from "../src/kernel";

export default function Authenticate() {
  const auth = useAuthentication();
  const kernel = useKernel();
  const router = useRouter();
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
      if (kernel.current) await kernel.forget(kernel.current);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  const current = kernel.current;
  // The name given on this phone, else the workspace's own.
  const title =
    current?.alias ||
    auth.health?.workspace.name ||
    (current ? keptName(current) : "Your workspace");
  const host = current ? new URL(current.kernel).host : undefined;
  // Its kernel did not answer: said in a line, the network's own words left out.
  const offline = !auth.loading && !auth.health && Boolean(auth.error);
  return (
    <SafeArea className="flex-1 bg-background">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="grow justify-center gap-5 p-6"
      >
        <View className="flex-row items-center gap-3.5">
          {current ? (
            <WorkspaceMark id={current.id} name={title} size="lg" />
          ) : null}
          <View className="min-w-0 flex-1">
            <Text className="text-[28px] font-semibold tracking-tight">
              {joining ? "Join " : ""}
              {title}
            </Text>
            {host && host !== title ? (
              <Text className="font-mono text-[13px] text-muted-foreground">
                {host}
              </Text>
            ) : null}
          </View>
        </View>
        <View className="gap-2">
          <Text className="text-base leading-6 text-muted-foreground">
            {offline
              ? `${host ?? "The kernel"} is not reachable.`
              : auth.loading
                ? "Verifying the workspace…"
                : invite && inviteError
                  ? `This invitation can no longer be used (${inviteError}). Ask for a new one.`
                  : joining
                    ? auth.identity
                      ? "Join this workspace with the account you are signed in to."
                      : invitation
                        ? `${invitation.invited_by} invited you.`
                        : "Reading the invitation…"
                    : auth.identity
                      ? enrollment
                        ? "Bind your account to this workspace’s owner."
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
        {error || (auth.error && !offline) ? (
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
            <Text>{offline ? "Try again" : "Verify connection again"}</Text>
          </Button>
        )}
        {kernel.workspaces.length > 1 ? (
          <Button
            variant="ghost"
            disabled={auth.busy}
            onPress={() => router.push("/workspaces")}
          >
            <Text>Choose another workspace</Text>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          disabled={auth.busy}
          onPress={() => {
            if (!invite && kernel.workspaces.length > 1)
              return router.push("/workspace-add");
            setPendingInvite(null);
            void changeKernel();
          }}
        >
          <Text>
            {invite
              ? "Use another link"
              : kernel.workspaces.length > 1
                ? "Add workspace"
                : "Connect to another kernel"}
          </Text>
        </Button>
      </ScrollView>
    </SafeArea>
  );
}
