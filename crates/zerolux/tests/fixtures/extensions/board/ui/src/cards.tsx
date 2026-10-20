import { useState } from "react";
import {
  Badge,
  Button,
  Empty,
  Heading,
  Input,
  List,
  ListItem,
  Stack,
  useAction,
  useActionResult,
  useEvent,
} from "@zerolux/ui";

type Card = { id: string; title: string; done: boolean };

/** The board's cards, drawn by the app with its own components. */
export default function Cards() {
  const cards = useActionResult<{ cards: Card[] }>("cards", {});
  const add = useAction("add");
  const done = useAction("done");
  const [title, setTitle] = useState("");
  useEvent("zerolux.board/changed", () => cards.reload());
  return (
    <Stack gap={12}>
      <Heading>Cards</Heading>
      {cards.data?.cards.length ? (
        <List>
          {cards.data.cards.map((card) => (
            <ListItem
              key={card.id}
              title={card.title}
              accessory={card.done ? <Badge>Done</Badge> : undefined}
              onPress={() => done.run({ id: card.id })}
            />
          ))}
        </List>
      ) : (
        <Empty>No cards</Empty>
      )}
      <Stack direction="row" gap={8}>
        <Input value={title} onChange={setTitle} placeholder="Title" />
        <Button
          title="Add"
          disabled={!title.trim()}
          onPress={async () => {
            await add.run({ title });
            setTitle("");
          }}
        />
      </Stack>
    </Stack>
  );
}
