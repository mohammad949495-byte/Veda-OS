import { createFileRoute } from "@tanstack/react-router";
import { VedaConsole } from "@/components/veda/console";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <VedaConsole />;
}
