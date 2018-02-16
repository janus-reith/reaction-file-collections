import { Meteor } from "meteor/meteor";
import { Mongo, MongoInternals } from "meteor/mongo";
import { WebApp } from "meteor/webapp";
import { check } from "meteor/check";
import fetch from "node-fetch";
import { FileDownloadManager, FileRecord, FileWorker, MeteorFileCollection, TempFileStore } from "@reactioncommerce/file-collections";
import GridFSStore from "@reactioncommerce/file-collections-sa-gridfs";

// handle any unhandled Promise rejections
process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err); // eslint-disable-line no-console
});

// lazy loading sharp package
let sharp;
async function lazyLoadSharp() {
  if (sharp) return;
  const mod = await import("sharp");
  sharp = mod.default;
}

const chunkSize = 1 * 1024 * 1024;
const mongodb = MongoInternals.NpmModules.mongodb.module;
const { db } = MongoInternals.defaultRemoteCollectionDriver().mongo;

const stores = [
  new GridFSStore({
    chunkSize,
    db,
    mongodb,
    name: "images",
    async transformWrite(fileRecord) {
      await lazyLoadSharp();

      // Need to update the content type and extension of the file info, too.
      // The new size gets set correctly automatically.
      fileRecord.type("image/jpeg", { store: "images" });
      fileRecord.extension("jpg", { store: "images" });

      // Resize keeping aspect ratio so that largest side is max 1600px, and convert to JPEG if necessary
      return sharp().resize(1600, 1600).max().toFormat("jpg");
    }
  }),

  new GridFSStore({
    chunkSize,
    db,
    mongodb,
    name: "thumbs",
    async transformWrite(fileRecord) {
      await lazyLoadSharp();

      // Need to update the content type and extension of the file info, too.
      // The new size gets set correctly automatically.
      fileRecord.type("image/png", { store: "thumbs" });
      fileRecord.extension("png", { store: "thumbs" });

      // Resize to 100x100 square, cropping to fit, and convert to PNG if necessary
      return sharp().resize(100, 100).crop().toFormat("png");
    }
  })
];

const tempStore = new TempFileStore({
  shouldAllowRequest(req) {
    const { type } = req.uploadMetadata;
    if (typeof type !== "string" || !type.startsWith("image/")) {
      console.info(`shouldAllowRequest received request to upload file of type "${type}" and denied it`); // eslint-disable-line no-console
      return false;
    }
    return true;
  }
});

const Images = new MeteorFileCollection("Images", {
  check,
  collection: new Mongo.Collection("ImagesFileCollection"),
  DDP: Meteor,
  shouldAllowGet: () => true, // add more security here if the files should not be public
  stores,
  tempStore
});

Meteor.methods({
  insertRemoteImage(url) {
    check(url, String);
    const fileRecord = Promise.await(FileRecord.fromUrl(url, { fetch }));
    return Images.insert(fileRecord, { raw: true });
  },
  removeImage(id) {
    const fileRecord = Promise.await(Images.findOne(id));
    if (!fileRecord) throw new Meteor.Error("not-found", `No FileRecord has ID ${id}`);
    const result = Promise.await(Images.remove(fileRecord));
    return result;
  },
  removeAllImages() {
    const images = Promise.await(Images.find());
    const result = Promise.await(Promise.all(images.map((fileRecord) => Images.remove(fileRecord))));
    return result;
  }
});

const downloadManager = new FileDownloadManager({
  collections: [Images],
  headers: {
    get: {
      "Cache-Control": "public, max-age=31536000"
    }
  }
});

const fileWorker = new FileWorker({
  fetch,
  fileCollections: [Images]
});
fileWorker.startProcessingRemoteURLs();
fileWorker.startProcessingUploads();

WebApp.connectHandlers.use("/uploads", tempStore.connectHandler);
WebApp.connectHandlers.use("/files", downloadManager.connectHandler);