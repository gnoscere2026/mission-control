export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <div>
      <h1>Mission Control</h1>
      {error ? <p style={{ color: "crimson" }}>Wrong secret.</p> : null}
      <form method="post" action="/api/login">
        <label>
          Shared secret{" "}
          <input type="password" name="secret" autoFocus autoComplete="current-password" />
        </label>{" "}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
