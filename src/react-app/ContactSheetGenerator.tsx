import AwsS3 from "@uppy/aws-s3";
import Uppy from "@uppy/core";
import { Dashboard } from "@uppy/react";
import React, { useEffect, useState } from "react";

import "@uppy/core/dist/style.min.css";
import "@uppy/dashboard/dist/style.min.css";

interface ContactSheetGeneratorProps {}

const ContactSheetGenerator: React.FC<ContactSheetGeneratorProps> = () => {
  const [contactSheetUrl, setContactSheetUrl] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<
    Array<{ key: string; url: string }>
  >([]);

  const [uppy] = useState(() => {
    const uppyInstance = new Uppy({
      id: "contact-sheet-uploader",
      restrictions: {
        maxFileSize: 50 * 1024 * 1024, // 50MB
        maxNumberOfFiles: 100,
        allowedFileTypes: ["image/*"],
      },
      autoProceed: false,
      allowMultipleUploadBatches: true,
      logger: {
        debug: () => {},
        warn: () => {},
        error: () => {},
      }, // Minimal logger for performance
    });

    uppyInstance.use(AwsS3, {
      shouldUseMultipart: false,
      limit: 20, // High concurrency
      getUploadParameters: async (file: any) => {
        try {
          console.log(
            `Getting upload parameters for: ${file.name} (${file.type})`
          );

          const response = await fetch("/api/upload-presigned", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              filename: file.name,
              contentType: file.type,
              fileSize: file.size, // Add file size like reference
            }),
          });

          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to get upload parameters: ${errorText}`);
          }

          const data = await response.json();
          console.log("Upload parameters received:", data);

          return {
            method: "PUT",
            url: data.url,
            fields: {},
            headers: {
              "Content-Type": file.type,
            },
          };
        } catch (error) {
          console.error("Error getting upload parameters:", error);
          throw error;
        }
      },
    });

    return uppyInstance;
  });

  useEffect(() => {
    const handleUploadSuccess = (file: any, response: any) => {
      console.log("Upload success:", file, response);
      if (file && response) {
        // For R2 presigned URLs, the uploadURL is the final location
        const uploadUrl = response.uploadURL;

        if (uploadUrl) {
          // The uploadURL from a successful presigned URL upload is the final location
          // Remove query parameters to get the clean file URL
          const cleanUrl = uploadUrl.split("?")[0];

          // Extract the key from the URL and use custom domain
          const urlParts = cleanUrl.split("/");
          const key = urlParts.slice(-2).join("/"); // get "uploads/filename.jpg"

          // Use the custom domain URL directly
          const customDomainUrl = `https://csh.qarta.ge/${key}`;

          console.log(`File uploaded: ${file.name}`);
          console.log(`Clean URL: ${cleanUrl}`);
          console.log(`Custom Domain URL: ${customDomainUrl}`);

          setUploadedFiles((prev) => [
            ...prev,
            { key: file.name, url: customDomainUrl },
          ]);
        } else {
          console.warn("No upload URL found in response:", response);
        }
      }
    };

    const handleComplete = (result: any) => {
      console.log("Upload complete:", result);
      if (result.successful && result.successful.length > 0) {
        result.successful.forEach((file: any) => {
          console.log("Successfully uploaded:", file.name);
        });
      }
    };

    const handleUploadError = (file: any, error: any) => {
      console.error("Upload error:", file?.name || "unknown file", error);
    };

    uppy.on("upload-success", handleUploadSuccess);
    uppy.on("complete", handleComplete);
    uppy.on("upload-error", handleUploadError);

    return () => {
      uppy.off("upload-success", handleUploadSuccess);
      uppy.off("complete", handleComplete);
      uppy.off("upload-error", handleUploadError);
    };
  }, [uppy]);

  const generateContactSheet = async () => {
    if (uploadedFiles.length === 0) {
      alert("Please upload some images first");
      return;
    }

    setIsGenerating(true);
    try {
      const response = await fetch("/api/generate-contact-sheet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          imageUrls: uploadedFiles.map((file) => file.url),
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to generate contact sheet: ${errorText}`);
      }

      // Get the blob data
      const blob = await response.blob();

      // Create a blob URL for preview
      const blobUrl = URL.createObjectURL(blob);
      setContactSheetUrl(blobUrl);

      // Trigger automatic download
      const contentDisposition = response.headers.get("content-disposition");
      const filename = contentDisposition
        ? contentDisposition.split("filename=")[1]?.replace(/"/g, "")
        : `contact-sheet-${Date.now()}.png`;

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      console.log("Contact sheet generated and downloaded successfully");
    } catch (error) {
      console.error("Error generating contact sheet:", error);
      alert(`Failed to generate contact sheet: ${error}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const resetUploader = () => {
    setUploadedFiles([]);
    setContactSheetUrl(null);
    uppy.cancelAll();
    uppy.getFiles().forEach((file) => {
      uppy.removeFile(file.id);
    });
  };

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "20px" }}>
      <h1>Contact Sheet Generator</h1>
      <p>Upload multiple images and generate a contact sheet</p>

      <div style={{ marginBottom: "20px" }}>
        <Dashboard
          uppy={uppy}
          theme="light"
          showProgressDetails={true}
          note="Images only, up to 50MB each, max 50 files"
          height={350}
          proudlyDisplayPoweredByUppy={false}
        />
      </div>

      {uploadedFiles.length > 0 && (
        <div
          style={{
            marginBottom: "20px",
            padding: "15px",
            backgroundColor: "#f8f9fa",
            borderRadius: "6px",
          }}
        >
          <h3 style={{ margin: "0 0 10px 0" }}>
            Uploaded Files ({uploadedFiles.length})
          </h3>
          <div style={{ fontSize: "14px", color: "#666" }}>
            {uploadedFiles.map((file, index) => (
              <div key={index} style={{ marginBottom: "5px" }}>
                ✓ {file.key}
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: "10px", marginBottom: "20px" }}>
        <button
          onClick={generateContactSheet}
          disabled={uploadedFiles.length === 0 || isGenerating}
          style={{
            padding: "12px 24px",
            backgroundColor:
              uploadedFiles.length > 0 && !isGenerating ? "#0070f3" : "#ccc",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor:
              uploadedFiles.length > 0 && !isGenerating
                ? "pointer"
                : "not-allowed",
            fontSize: "16px",
          }}
        >
          {isGenerating
            ? "Generating..."
            : `Generate Contact Sheet (${uploadedFiles.length} images)`}
        </button>

        <button
          onClick={resetUploader}
          style={{
            padding: "12px 24px",
            backgroundColor: "#666",
            color: "white",
            border: "none",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "16px",
          }}
        >
          Reset
        </button>
      </div>

      {contactSheetUrl && (
        <div style={{ marginTop: "20px" }}>
          <h2>Generated Contact Sheet</h2>
          <div
            style={{
              border: "1px solid #ddd",
              padding: "10px",
              borderRadius: "6px",
            }}
          >
            <img
              src={contactSheetUrl}
              alt="Generated contact sheet"
              style={{ maxWidth: "100%", height: "auto" }}
            />
            <div style={{ marginTop: "10px" }}>
              <a
                href={contactSheetUrl}
                download="contact-sheet.png"
                style={{
                  display: "inline-block",
                  padding: "8px 16px",
                  backgroundColor: "#28a745",
                  color: "white",
                  textDecoration: "none",
                  borderRadius: "4px",
                }}
              >
                Download Contact Sheet
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ContactSheetGenerator;
