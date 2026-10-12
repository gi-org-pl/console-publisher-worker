import path from "node:path";
import { z } from "zod";
import { MAX_IMAGE_BYTES } from "../../src/schemas/publishing.ts";
import { invalidJob } from "./errors.mjs";

// The job file: the name of the post, its text and its images. Everything
// here is read from inside the folder of the job, and nothing is sent.

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const variantSchema = z.strictObject({
  text: z.string().optional(),
  image: z.string().optional(),
});
const jobSchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/, {
    message: "3 to 64 lower-case letters, digits and hyphens",
  }),
  text: z.string(),
  image: z.string(),
  channels: z.array(z.string().min(1)).min(1).optional(),
  overrides: z.record(z.string().min(1), variantSchema).default({}),
});

/** A PNG of the job, read from inside the job's folder and nowhere else. */
async function readImage(folder, file, fs) {
  const refuse = (why) => invalidJob(`The image "${file}" ${why}.`);
  if (path.isAbsolute(file))
    throw refuse("has to be a path inside the folder of the job");
  let real;
  let size;
  try {
    real = await fs.realpath(path.resolve(folder, file));
    size = (await fs.stat(real)).size;
  } catch {
    throw refuse("cannot be read");
  }
  const inside = path.relative(folder, real);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside))
    throw refuse("is not inside the folder of the job");
  if (size > MAX_IMAGE_BYTES) throw refuse("is larger than 5 MB");
  const bytes = await fs.readFile(real);
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte))
    throw refuse("is not a PNG");
  return bytes;
}

/** Reads the job and its images; nothing leaves the machine here. */
export async function readJob(file, { cwd, fs }) {
  const jobPath = path.resolve(cwd, file);
  let parsed;
  try {
    parsed = jobSchema.safeParse(
      JSON.parse(UTF8.decode(await fs.readFile(jobPath))),
    );
  } catch (cause) {
    // What the file holds is not repeated: it may be any file.
    throw invalidJob(
      `Cannot read the job: ${cause?.code ?? "it is not JSON in UTF-8"}.`,
    );
  }
  if (!parsed.success)
    throw invalidJob(
      `The job is not valid: ${parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".") || "job"}: ${issue.code === "unrecognized_keys" ? "has keys this script does not know" : issue.message}`,
        )
        .join("; ")}.`,
    );
  const job = parsed.data;
  const folder = path.dirname(await fs.realpath(jobPath));
  const files = new Set([
    job.image,
    ...Object.values(job.overrides).flatMap(({ image }) => image ?? []),
  ]);
  const images = new Map();
  for (const name of files) images.set(name, await readImage(folder, name, fs));
  return { job, images };
}
