import { useState } from "react";
import { ScrollView, View } from "react-native";
import { errorMessage, ownerNameError } from "@zerolux/chat";
import { Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SafeArea } from "@/components/ui/native";
import { Text } from "@/components/ui/text";
import { useAuthentication } from "../src/auth";
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
  if (!auth) return null;
  const enrollment =
    auth.identity?.setup_required ?? auth.health?.auth.setup_required ?? false;
  const signup = enrollment && !existing && !auth.identity;
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
      ? await auth.claim()
      : signup
        ? await auth.signUp(name, email, password)
        : await auth.signIn(email, password);
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
            {auth.health?.workspace.name ?? "Your workspace"}
          </Text>
          <Text className="text-base leading-6 text-muted-foreground">
            {auth.loading
              ? "Verifying the workspace…"
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
            {(!auth.identity || enrollment) && (
              <Button
                disabled={auth.busy || Boolean(invalid)}
                onPress={() => void submit()}
              >
                <Text>
                  {auth.busy
                    ? "Please wait…"
                    : auth.identity
                      ? "Claim workspace"
                      : signup
                        ? "Create account"
                        : "Sign in"}
                </Text>
              </Button>
            )}
            {!auth.identity && enrollment && (
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
          onPress={() => void changeKernel()}
        >
          <Text>Connect to another kernel</Text>
        </Button>
      </ScrollView>
    </SafeArea>
  );
}
