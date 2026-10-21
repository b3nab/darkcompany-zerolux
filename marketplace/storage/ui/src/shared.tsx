import {
  DropZone,
  Empty,
  FileButton,
  Icon,
  List,
  ListItem,
  Menu,
  Spinner,
  Stack,
  Text,
  useAction,
  useActionResult,
  useDownload,
  useEvent,
  useUpload,
} from "@zerolux/ui";
import type { PickedFile } from "@zerolux/ui";
import { fileIcon, size, when, type StoredFile } from "./parts/files";

/**
 * The files shared in a chat, beside it: downloaded with a press, and shared there by picking
 * or dropping them. The chat is the place the view shows in.
 */
export default function Shared() {
  const files = useActionResult<{ files: StoredFile[] }>("files", {});
  useEvent("changed", () => void files.reload());
  const upload = useUpload("upload");
  const download = useDownload("download");
  const share = useAction("share");
  const send = async (picked: PickedFile[]) => {
    for (const { file, name } of picked)
      await upload.upload(file, name).catch(() => {});
    // Read again at once, not only when the notice comes.
    void files.reload();
  };
  const error = files.error || upload.error || download.error || share.error;

  return (
    <DropZone label="Drop to share" onFiles={(picked) => void send(picked)}>
      <Stack gap={8}>
        {error && <Text tone="danger">{error}</Text>}
        {files.loading && !files.data ? (
          <Spinner size="sm" />
        ) : files.data?.files.length ? (
          <List>
            {files.data.files.map((file) => (
              <ListItem
                key={file.id}
                title={file.name}
                subtitle={`${size(file.size)} · ${when(file.updated_at)}`}
                leading={<Icon name={fileIcon(file)} />}
                onPress={() => void download.download({ id: file.id })}
                accessory={
                  <Menu
                    label="File actions"
                    items={[
                      {
                        title: "Download",
                        icon: "download",
                        onPress: () => void download.download({ id: file.id }),
                      },
                      {
                        title: "Stop sharing",
                        icon: "link-2-off",
                        onPress: () =>
                          void share
                            .run({ id: file.id, conversation_id: null })
                            .then(
                              () => files.reload(),
                              () => {},
                            ),
                      },
                    ]}
                  />
                }
              />
            ))}
          </List>
        ) : (
          <Empty>No files</Empty>
        )}
        <FileButton
          title="Upload"
          multiple
          busy={upload.busy}
          onFiles={(picked) => void send(picked)}
        />
      </Stack>
    </DropZone>
  );
}
