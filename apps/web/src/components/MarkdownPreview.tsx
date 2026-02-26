import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({
  markdown,
  emptyLabel = "(empty)",
}: {
  markdown: string;
  emptyLabel?: string;
}) {
  const text = markdown?.trim() ? markdown : "";
  return (
    <div className="md-preview">
      {text ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      ) : (
        <div className="text-sm text-zinc-500 dark:text-zinc-400">
          {emptyLabel}
        </div>
      )}
    </div>
  );
}
